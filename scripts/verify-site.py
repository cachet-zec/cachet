#!/usr/bin/env python3
"""Check that a Cachet site serves the engine this repository contains.

The mint worker and the wasm engines are plain files under `console/public/`,
committed to git, with their SHA-256 in `engine-manifest.json`. This script
downloads them from a live site and compares them with this checkout.

    python scripts/verify-site.py                   # cachetzec.com
    python scripts/verify-site.py --site https://your.site
    python scripts/verify-site.py --write-manifest  # after rebuilding the engines
    python scripts/verify-site.py --check-manifest  # CI

Check out the release tag to compare against first. Standard library only.
Not covered: the application JavaScript, which Next.js does not build
reproducibly. Running the console from source covers both.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PUBLIC = REPO / "console" / "public"
MANIFEST = PUBLIC / "engine-manifest.json"
DEFAULT_SITE = "https://cachetzec.com"

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

# Everything a mint executes that is not the application bundle.
ENGINE_ROOTS = ("mint-worker.js", "mint-engine", "mint-engine-mt", "verify-engine")


def engine_files() -> dict[str, str]:
    """Site path -> SHA-256 of the file in this checkout, sorted."""
    found: dict[str, str] = {}
    for root in ENGINE_ROOTS:
        target = PUBLIC / root
        if not target.exists():
            raise SystemExit(f"this checkout has no console/public/{root}: nothing to compare against")
        paths = [target] if target.is_file() else sorted(p for p in target.rglob("*") if p.is_file())
        for path in paths:
            found[path.relative_to(PUBLIC).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return dict(sorted(found.items()))


def checkout_label() -> str:
    try:
        return subprocess.run(
            ["git", "-C", str(REPO), "describe", "--tags", "--always", "--dirty"],
            capture_output=True,
            text=True,
            check=True,
            timeout=15,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return "unknown (not a git checkout)"


def write_manifest() -> int:
    files = engine_files()
    body = {
        "about": "SHA-256 of every file a browser mint executes besides the application bundle. "
        "Verify a live site against it with scripts/verify-site.py.",
        "files": files,
    }
    MANIFEST.write_bytes((json.dumps(body, indent=2) + "\n").encode("utf-8"))
    print(f"wrote {MANIFEST.relative_to(REPO).as_posix()} ({len(files)} files)")
    return 0


def check_manifest() -> int:
    if not MANIFEST.exists():
        print("engine-manifest.json is missing: run scripts/verify-site.py --write-manifest")
        return 1
    listed = json.loads(MANIFEST.read_bytes())["files"]
    actual = engine_files()
    problems = [
        f"  {path}: " + ("not in the manifest" if path not in listed else "missing on disk" if path not in actual else "hash differs")
        for path in sorted(set(listed) | set(actual))
        if listed.get(path) != actual.get(path)
    ]
    if problems:
        print("engine-manifest.json does not match console/public:")
        print("\n".join(problems))
        print("an engine file changed without the manifest: rebuild deliberately, then --write-manifest")
        return 1
    print(f"engine manifest matches {len(actual)} files")
    return 0


def verify_site(site: str) -> int:
    site = site.rstrip("/")
    files = engine_files()
    # The checkout itself must be coherent first: same files, same hashes as
    # the manifest it commits.
    if check_manifest() != 0:
        return 1
    print(f"site      {site}")
    print(f"checkout  {checkout_label()}")
    print()
    mismatched = unreachable = 0
    for path, expected in files.items():
        try:
            with _OPENER.open(f"{site}/{path}", timeout=60) as response:
                served = hashlib.sha256(read_capped(response)).hexdigest()
        except (urllib.error.URLError, OSError, ValueError) as error:
            unreachable += 1
            print(f"  ??        {path}  ({printable(error)})")
            continue
        if served == expected:
            print(f"  match     {path}  {expected[:16]}...")
        else:
            mismatched += 1
            print(f"  DIFFERENT {path}")
            print(f"            checkout {expected}")
            print(f"            served   {served}")

    print()
    if mismatched:
        print(f"{mismatched} file(s) DIFFER from this checkout.")
        print("Either the site runs another version (check out its release tag and re-run),")
        print("or it serves an engine that is not the published one. Do not mint there until you know which.")
        return 1
    if unreachable:
        print(f"{unreachable} file(s) could not be fetched; the rest matched.")
        return 2
    print(f"all {len(files)} engine files served by {site} are byte-identical to this checkout.")
    print("not covered: the application JavaScript around the engine, and whether the site")
    print("serves a browser the same bytes it served this script.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--site", default=DEFAULT_SITE, help=f"site to verify (default {DEFAULT_SITE})")
    parser.add_argument("--write-manifest", action="store_true", help="regenerate engine-manifest.json")
    parser.add_argument("--check-manifest", action="store_true", help="fail if the manifest is stale")
    args = parser.parse_args()
    if args.write_manifest:
        return write_manifest()
    if args.check_manifest:
        return check_manifest()
    return verify_site(args.site)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
