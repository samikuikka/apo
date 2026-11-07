"""Shared annotated route parameter types."""

from typing import Annotated

from fastapi import Path

# SQLite integer ids are 64-bit signed row ids. An out-of-range value
# must fail validation (422) at the boundary; reaching the query raises
# sqlite3.OverflowError, which surfaces as a 500.
SqliteRowId = Annotated[int, Path(ge=1, le=2**63 - 1)]
