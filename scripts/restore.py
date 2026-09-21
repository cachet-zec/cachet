#!/usr/bin/env python3
"""Rebuild a Cachet instance's content from a mirror, over its public API.

The other half of `mirror.py`. It only uses the two routes open to everyone,
which the target checks against the chain (bundles stored under their own
hash, descriptions accepted only if they match the on-chain commitment), so
it needs no database access and cannot restore anything false.

    python scripts/mirror.py --out ./mirror
    python scripts/restore.py --to https://api.new.instance

The target must read the same chain and not be paused. Standard library
only; re-running is safe. Exit 0: every bundle landed under its hash.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# Stay well under the target's per-client upload budget.
UPLOAD_PAUSE_SECONDS = 1.5
RESOLVE_PAUSE_SECONDS = 0.15


class RestoreError(RuntimeError):
    pass

# Everything below talks to a server this script does not trust. Reads are
# capped, redirects are refused (a hostile registry could otherwise steer
# requests at another host), and what it says is printed with control
# characters removed.
MAX_RESPONSE_BYTES = 64 * 1024 * 1024


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        raise urllib.error.HTTPError(req.full_url, code, "redirect refused", headers, fp)


_OPENER = urllib.request.build_opener(_NoRedirect)


def read_capped(response, limit: int = MAX_RESPONSE_BYTES) -> bytes:
    data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"response larger than {limit} bytes")
    return data


def printable(value: object, limit: int = 200) -> str:
    return "".join(c if c.isprintable() else "?" for c in str(value))[:limit]


def is_hex(value: object, length: int) -> bool:
    return isinstance(value, str) and len(value) == length and all(c in "0123456789abcdef" for c in value)


def post(api: str, path: str, body: dict, timeout: int = 60) -> tuple[int, dict | str]:
    request = urllib.request.Request(
        api.rstrip("/") + path,
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            return response.status, json.loads(read_capped(response).decode("utf-8"))
    except urllib.error.HTTPError as error:
        text = error.read(64 * 1024).decode("utf-8", "replace")
        try:
            return error.code, json.loads(text)
        except ValueError:
            return error.code, text
    except Exception as error:  # network, TLS, timeout
        raise RestoreError(f"{path}: {error}") from error


def detail(answer: dict | str) -> str:
    if isinstance(answer, dict):
        return printable(answer.get("detail") or answer.get("title") or answer)
    return printable(answer)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--to", required=True, help="API of the instance to restore into")
    parser.add_argument("--mirror", default="mirror", help="mirror directory (default ./mirror)")
    parser.add_argument("--limit", type=int, default=0, help="stop after N bundles (0 = all)")
    args = parser.parse_args()

    mirror = Path(args.mirror)
    payload_file = mirror / "payload.json"
    bundles_dir = mirror / "bundles"
    if not payload_file.exists() or not bundles_dir.is_dir():
        raise RestoreError(f"{mirror} is not a mirror (run scripts/mirror.py first)")
    payload = json.loads(payload_file.read_bytes())

    print(f"restoring {mirror.resolve()} into {args.to}")

    # A bundle with no resolved description is swept as an orphan, so each
    # bundle is followed at once by the descriptions that reference it.
    # The payload was written by the registry that was mirrored: an asset id
    # ends up in a URL path, so only a real one is used.
    assets = [
        asset
        for asset in payload.get("assets", [])
        if isinstance(asset, dict)
        and is_hex(asset.get("asset_id"), 64)
        and isinstance(asset.get("description"), str)
        and asset["description"]
    ]
    by_bundle: dict[str, list[dict]] = {}
    for asset in assets:
        try:
            envelope = json.loads(asset["description"])
        except ValueError:
            continue
        if isinstance(envelope, dict) and isinstance(envelope.get("sha256"), str):
            by_bundle.setdefault(envelope["sha256"].lower(), []).append(asset)

    resolved = refused = 0
    refusals: list[str] = []
    done: set[str] = set()

    def resolve(asset: dict) -> None:
        nonlocal resolved, refused
        done.add(asset["asset_id"])
        status, answer = post(
            args.to,
            f"/api/v1/assets/{asset['asset_id']}/description",
            {"description": asset["description"]},
        )
        if status == 200:
            resolved += 1
        else:
            refused += 1
            if len(refusals) < 5:
                refusals.append(f"{asset['asset_id'][:16]}...: HTTP {status} {detail(answer)}")
        time.sleep(RESOLVE_PAUSE_SECONDS)

    # 1. Bundles, each with its descriptions. Re-hashed before sending, and
    #    the target must answer with the same hash.
    files = sorted(bundles_dir.glob("*.json"))
    if args.limit:
        files = files[: args.limit]
    stored = withheld = 0
    failures: list[str] = []
    for index, file in enumerate(files):
        expected = file.stem
        raw = file.read_bytes()
        if hashlib.sha256(raw).hexdigest() != expected:
            failures.append(f"{file.name}: local bytes do not match the file name, not sent")
            continue
        bundle = json.loads(raw)
        if not isinstance(bundle, dict):
            failures.append(f"{file.name}: not a metadata bundle, not sent")
            continue
        body = {key: bundle[key] for key in ("name", "description", "image_data_uri", "external_url") if key in bundle}
        status, answer = post(args.to, "/api/v1/metadata", body)
        if status == 410:
            withheld += 1  # the target's operator withholds these bytes: their call
        elif status == 201 and isinstance(answer, dict) and answer.get("sha256") == expected:
            stored += 1
            for asset in by_bundle.get(expected, []):
                resolve(asset)
        elif status == 201:
            failures.append(f"{file.name}: target stored it under {printable(answer.get('sha256') if isinstance(answer, dict) else answer)}")
        elif status == 429:
            raise RestoreError("the target's upload budget is spent; wait a minute and re-run (it resumes)")
        elif status == 503:
            raise RestoreError(f"the target refuses uploads right now: {detail(answer)}")
        else:
            failures.append(f"{file.name}: HTTP {status} {detail(answer)}")
        if index + 1 < len(files):
            time.sleep(UPLOAD_PAUSE_SECONDS)

    print(f"  bundles       {stored} stored under their expected hash" + (f", {withheld} withheld by the target" if withheld else ""))

    # 2. Descriptions that point at no bundle in this mirror.
    for asset in assets:
        if asset["asset_id"] not in done:
            resolve(asset)

    print(f"  descriptions  {resolved} accepted, {refused} refused (of {len(assets)})")
    for line in refusals:
        print(f"                {line}")
    if refused:
        print("                a refusal usually means the target has not indexed that asset yet,")
        print("                or reads another chain. Re-run once it has caught up.")

    if failures:
        print("\nNOT RESTORED:")
        for failure in failures:
            print(f"  {failure}")
        return 1

    if refused:
        # Bundles whose descriptions were refused are orphans on the target and
        # will be swept after its grace window: say so, do not claim done.
        print(f"\nrestore partial: {refused} descriptions refused. The bundles they reference")
        print("will be swept by the target as orphans; re-run once it follows the same chain.")
        return 3
    print("\nrestore complete: the target checked every item against the chain itself.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RestoreError as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(2)
    except KeyboardInterrupt:
        sys.exit(130)
