"""Sanity check that GitHub OAuth env vars are loaded correctly.

Run from the backend directory:
    uv run python scripts/check_github_config.py
"""

from dotenv import load_dotenv

load_dotenv()  # pull values from .env so this works standalone

from apo.services.github_oauth import is_github_enabled, load_github_config


def main() -> None:
    if not is_github_enabled():
        print("❌ GitHub OAuth is NOT enabled.")
        print()
        print("Required env vars (all four must be set):")
        for name in (
            "GITHUB_CLIENT_ID",
            "GITHUB_CLIENT_SECRET",
            "GITHUB_REDIRECT_URI",
            "GITHUB_TOKEN_ENCRYPTION_KEY",
        ):
            import os

            value = os.environ.get(name, "")
            marker = "✓" if value else "✗"
            preview = value[:8] + "…" if len(value) > 8 else value
            print(f"  {marker} {name} = {preview}")
        return

    config = load_github_config()
    assert config is not None
    print("✓ GitHub OAuth is enabled.")
    print(f"  Client ID:     {config.client_id[:10]}…")
    print(f"  Redirect URI:  {config.redirect_uri}")
    print(f"  Scopes:        repo (default)")
    print()
    print("Next: restart the backend, open a non-demo project's tasks")
    print("page, and look for the 'Connect GitHub' button above the URL field.")


if __name__ == "__main__":
    main()
