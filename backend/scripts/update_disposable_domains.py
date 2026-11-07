#!/usr/bin/env python3
# pyright: reportAny=false, reportUnusedCallResult=false

"""Regenerate the bundled disposable-email-domain blocklist.

Fetches the CC0 `disposable-email-domains` blocklist, validates every
entry, and writes `apo/data/disposable-email-domains.json` with
provenance headers. Deterministic given one upstream snapshot and one
`--snapshot` date: same inputs in, same bytes out. After writing, the
bundle is re-parsed through the production loader so a bad file can
never land silently.

Usage (from `backend/`):
    uv run python scripts/update_disposable_domains.py            # fetch + write
    uv run python scripts/update_disposable_domains.py --in FILE  # from a local conf

The JSON is the shipped artifact; committing its output is the whole
point, so a fresh snapshot needs a commit just like any other bundled
data change.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from datetime import date
from pathlib import Path

UPSTREAM_URL = (
    "https://raw.githubusercontent.com/disposable-email-domains/"
    "disposable-email-domains/main/disposable_email_blocklist.conf"
)
UPSTREAM_REPO = (
    "https://github.com/disposable-email-domains/disposable-email-domains"
)

BACKEND_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = BACKEND_ROOT / "apo" / "data" / "disposable-email-domains.json"

# A registrable domain: dot-separated labels, each a DNS label. Covers
# punycode (xn--…) because the charset is ascii lowercase.
_DOMAIN_RE = re.compile(
    r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$"
)


def parse_conf(text: str, source: str) -> list[str]:
    """Validate and dedupe the upstream conf into a sorted domain list."""
    domains: set[str] = set()
    for lineno, raw in enumerate(text.splitlines(), start=1):
        entry = raw.strip()
        if not entry or entry.startswith("#"):
            continue
        if not _DOMAIN_RE.fullmatch(entry):
            sys.exit(f"{source}:{lineno}: not a lowercase dotted domain: {entry!r}")
        domains.add(entry)
    if not domains:
        sys.exit(f"{source}: no domains found, refusing to write an empty blocklist")
    return sorted(domains)


def write_bundle(domains: list[str], snapshot: str) -> None:
    comment = (
        "Bundled disposable (throwaway) email domain blocklist for "
        "admission. Source: the CC0 disposable-email-domains list "
        f"({UPSTREAM_REPO}), snapshot {snapshot}, {len(domains)} domains. "
        "Regenerate with backend/scripts/update_disposable_domains.py. "
        "Matching is exact or dot-suffix, so sub.mailinator.com matches "
        "mailinator.com but notmailinator.com never does. A small "
        "built-in allowlist of major consumer providers is subtracted at "
        "load time as a false-positive guard, and operators can allow "
        "further domains via APO_DISPOSABLE_DOMAIN_ALLOWLIST. "
        "Maintenance: on-demand, whoever ships a release."
    )
    bundle = {
        "_comment": comment,
        "_format": {
            "domains": (
                "sorted unique lowercase DNS domains; an email is blocked "
                "when its domain equals an entry or ends with '.' + entry"
            ),
            "snapshot": "YYYY-MM-DD date of the upstream snapshot",
        },
        "snapshot": snapshot,
        "domains": domains,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(bundle, indent=2, ensure_ascii=True) + "\n", encoding="utf-8"
    )
    # Round-trip through the production loader: if the written file were
    # rejected at startup, fail here instead, where the mistake is fixable.
    import sys

    sys.path.insert(0, str(BACKEND_ROOT))
    from apo.services.email_admission import build_disposable_domain_matcher

    build_disposable_domain_matcher(path=OUTPUT_PATH)
    print(f"wrote {OUTPUT_PATH} ({len(domains)} domains, snapshot {snapshot})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--in",
        dest="input_file",
        help="read the upstream conf from this file instead of the network",
    )
    parser.add_argument(
        "--snapshot",
        default=date.today().isoformat(),
        help="snapshot date to stamp (default: today)",
    )
    args = parser.parse_args()

    if args.input_file:
        text = Path(args.input_file).read_text(encoding="utf-8")
        source = args.input_file
    else:
        print(f"fetching {UPSTREAM_URL}")
        with urllib.request.urlopen(UPSTREAM_URL, timeout=60) as resp:
            text = resp.read().decode("utf-8")
        source = UPSTREAM_URL

    write_bundle(parse_conf(text, source), args.snapshot)


if __name__ == "__main__":
    main()
