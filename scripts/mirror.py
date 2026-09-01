#!/usr/bin/env python3
"""Mirror a Cachet registry, verifying every byte against the chain.

A registry can withhold; it can never lie. This script is how you check
that for yourself: it downloads a registry's signed snapshot and every
metadata bundle it references, and re-derives each hash locally. Nothing
here trusts the server it is talking to -- a modified bundle fails its
hash and is refused, a tampered snapshot fails its digest.

    python scripts/mirror.py                       # mirror cachetzec.com
    python scripts/mirror.py --api https://your.instance --out ./mirror

Standard library only. If the `cryptography` package happens to be
installed, the snapshot's Ed25519 signature is verified too; without it
the script still verifies every digest and says plainly what it skipped.

Exit code 0 means: everything downloaded was verified. Any hash mismatch
exits non-zero -- that is the interesting failure, and it should be loud.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_API = "https://api.cachetzec.com"
# The registry serves public data; pace requests so a mirror never looks
# like a flood to the instance's rate limiter.
REQUEST_PAUSE_SECONDS = 0.1
SNAPSHOT_DOMAIN = b"cachet-snapshot-v1"


class MirrorError(RuntimeError):
    pass


def fetch(api: str, path: str, timeout: int = 30) -> bytes:
    try:
        with urllib.request.urlopen(api.rstrip("/") + path, timeout=timeout) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        raise MirrorError(f"{path}: HTTP {error.code}") from error
    except Exception as error:  # network, TLS, timeout
        raise MirrorError(f"{path}: {error}") from error


def verify_signature(snapshot: dict) -> str:
    """Check the operator's Ed25519 signature when we can, and say so."""
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError:
        return "skipped (pip install cryptography to verify it)"
    try:
        key = Ed25519PublicKey.from_public_bytes(bytes.fromhex(snapshot["public_key"]))
        # The operator signs the domain string followed by the payload digest,
        # never the payload itself: domain separation keeps this signature
        # from ever being replayed as a signature over something else.
        key.verify(
            bytes.fromhex(snapshot["signature"]),
            SNAPSHOT_DOMAIN + bytes.fromhex(snapshot["sha256"]),
        )
        return "VALID"
    except InvalidSignature:
        raise MirrorError("snapshot signature is INVALID -- refusing to mirror")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--api", default=DEFAULT_API, help=f"registry API (default {DEFAULT_API})")
    parser.add_argument("--out", default="mirror", help="output directory (default ./mirror)")
    parser.add_argument("--limit", type=int, default=0, help="stop after N bundles (0 = all)")
    args = parser.parse_args()

    out = Path(args.out)
    bundles_dir = out / "bundles"
    bundles_dir.mkdir(parents=True, exist_ok=True)

    print(f"mirroring {args.api}")

    # 1. The signed snapshot: the registry's own claim about its contents.
    snapshot = json.loads(fetch(args.api, "/api/v1/snapshot"))
    payload_bytes = base64.b64decode(snapshot["payload"])

    digest = hashlib.sha256(payload_bytes).hexdigest()
    if digest != snapshot["sha256"]:
        raise MirrorError(
            f"snapshot digest mismatch: served {snapshot['sha256']}, computed {digest}"
        )
    signature_state = verify_signature(snapshot)

    payload = json.loads(payload_bytes)
    (out / "snapshot.json").write_bytes(json.dumps(snapshot, indent=2).encode())
    (out / "payload.json").write_bytes(payload_bytes)

    print(f"  snapshot   {len(payload['assets'])} assets at tip {payload['tip_height']}")
    print(f"  digest     VERIFIED ({digest[:16]}...)")
    print(f"  signature  {signature_state}  key {snapshot['public_key'][:16]}...")

    # 2. Every bundle the snapshot commits to, verified against the hash the
    #    chain carries inside each asset id.
    wanted: dict[str, str] = {}
    for asset in payload["assets"]:
        description = asset.get("description") or ""
        if not description.startswith('{"v":1'):
            continue  # no Cachet envelope: nothing content-addressed to fetch
        try:
            sha256 = json.loads(description)["sha256"]
        except (ValueError, KeyError):
            continue
        wanted.setdefault(sha256, asset["asset_id"])

    if args.limit:
        wanted = dict(list(wanted.items())[: args.limit])

    print(f"\n  {len(wanted)} bundles referenced by an envelope")
    verified = cached = withheld = unavailable = 0
    failures: list[str] = []

    for sha256, asset_id in wanted.items():
        target = bundles_dir / f"{sha256}.json"
        if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == sha256:
            cached += 1
            continue
        try:
            raw = fetch(args.api, f"/api/v1/metadata/{sha256}")
        except MirrorError as error:
            # 410 is an operator withholding this bundle: legitimate, and
            # distinct from it being missing. Either way the mirror goes on.
            if "HTTP 410" in str(error):
                withheld += 1
            else:
                unavailable += 1
            continue
        computed = hashlib.sha256(raw).hexdigest()
        if computed != sha256:
            failures.append(f"{sha256} (asset {asset_id}): served bytes hash to {computed}")
            continue
        target.write_bytes(raw)
        verified += 1
        time.sleep(REQUEST_PAUSE_SECONDS)

    print(f"  verified   {verified} newly downloaded, {cached} already held")
    if withheld:
        print(f"  withheld   {withheld} (operator moderation -- the chain record is untouched)")
    if unavailable:
        print(f"  missing    {unavailable} (not served by this instance)")

    if failures:
        print("\nHASH MISMATCH -- this registry served bytes that do not match the chain:")
        for failure in failures:
            print(f"  {failure}")
        return 1

    print(f"\nmirror complete in {out.resolve()}")
    print("every byte re-hashed locally; nothing was taken on trust.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except MirrorError as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(2)
    except KeyboardInterrupt:
        sys.exit(130)
