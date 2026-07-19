# pyright: reportIncompatibleVariableOverride=false

from datetime import datetime, timezone
from typing import ClassVar

from sqlalchemy import Column, DateTime
from sqlalchemy.sql import func
from sqlmodel import Field, SQLModel


class ModelDefinitionDB(SQLModel, table=True):
    __tablename__: ClassVar[str] = "model_definitions"

    id: int | None = Field(default=None, primary_key=True)
    project: str = Field(default="__global__", index=True)
    model_name: str = Field(index=True)
    match_pattern: str = Field(index=True)
    provider: str = Field(index=True)
    input_price: float = Field(default=0.0)
    output_price: float = Field(default=0.0)
    cached_input_price: float | None = Field(default=None)

    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(DateTime(timezone=True), server_default=func.now()),
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(
            DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
        ),
    )


class ModelDefinitionCreate(SQLModel):
    model_name: str
    match_pattern: str
    provider: str
    input_price: float = 0.0
    output_price: float = 0.0
    cached_input_price: float | None = None
    project: str = "__global__"


class ModelDefinitionResponse(SQLModel):
    id: int
    project: str
    model_name: str
    match_pattern: str
    provider: str
    input_price: float
    output_price: float
    cached_input_price: float | None
    created_at: datetime
    updated_at: datetime


class ModelMatchResponse(SQLModel):
    matched: bool = False
    model_name: str | None = None
    provider: str | None = None
    input_price: float | None = None
    output_price: float | None = None
    cached_input_price: float | None = None
    calculated_cost: float | None = None
