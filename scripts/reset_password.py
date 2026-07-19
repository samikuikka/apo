"""
Admin CLI to reset a user's password directly.
Usage: uv run python scripts/reset_password.py --email user@example.com --password NewPass123
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from apo.auth import hash_password, validate_password_strength
from apo.db import engine
from sqlmodel import Session, select

from apo.models.db import UserDB


def main() -> None:
    parser = argparse.ArgumentParser(description="Reset a user's password")
    parser.add_argument("--email", required=True, help="User email")
    parser.add_argument("--password", required=True, help="New password")
    args = parser.parse_args()

    error = validate_password_strength(args.password)
    if error:
        print(f"Password validation failed: {error}")
        sys.exit(1)

    with Session(engine) as session:
        user = session.exec(
            select(UserDB).where(UserDB.email == args.email)
        ).first()
        if not user:
            print(f"No user found with email: {args.email}")
            sys.exit(1)

        user.password_hash = hash_password(args.password)
        session.add(user)
        session.commit()
        print(f"Password reset successfully for {args.email}")


if __name__ == "__main__":
    main()
