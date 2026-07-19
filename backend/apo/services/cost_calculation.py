"""Token-based cost calculation and the default model pricing seed.

``DEFAULT_MODELS`` below is a *static seed*, not a live pricing source. Prices
change frequently and new models ship often, so this list **goes stale** — it
is best-effort and only consulted when a model definition has not been added
through the dashboard or API. To get accurate costs for current models:

1. Add or update the model via the pricing UI / ``ModelDefinitionDB`` API
   (per-project or ``__global__``), or
2. Edit the entries here and re-run ``seed_default_models`` on a fresh DB.

The durable fix is a pricing-feed integration; until then, treat the figures
below as illustrative, not authoritative.
"""

from typing import cast

import re
from sqlmodel import Session, select

from ..models.pricing import ModelDefinitionDB

# Last reviewed: 2026-01. Known gaps vs. the live market: no Claude 3.7/4,
# partial GPT-4.1 coverage, no 2026 model releases. See module docstring.
DEFAULT_MODELS: list[dict[str, object]] = [
    {"model_name": "gpt-4o", "match_pattern": r"gpt-4o(?!\-mini).*", "provider": "openai", "input_price": 2.50, "output_price": 10.00},
    {"model_name": "gpt-4o-mini", "match_pattern": r"gpt-4o-mini.*", "provider": "openai", "input_price": 0.15, "output_price": 0.60},
    {"model_name": "gpt-4.1", "match_pattern": r"gpt-4\.1(?!\-).*", "provider": "openai", "input_price": 2.00, "output_price": 8.00},
    {"model_name": "gpt-4.1-mini", "match_pattern": r"gpt-4\.1-mini.*", "provider": "openai", "input_price": 0.40, "output_price": 1.60},
    {"model_name": "gpt-4.1-nano", "match_pattern": r"gpt-4\.1-nano.*", "provider": "openai", "input_price": 0.10, "output_price": 0.40},
    {"model_name": "o1", "match_pattern": r"o1(?!\-mini).*", "provider": "openai", "input_price": 15.00, "output_price": 60.00},
    {"model_name": "o1-mini", "match_pattern": r"o1-mini.*", "provider": "openai", "input_price": 3.00, "output_price": 12.00},
    {"model_name": "o3-mini", "match_pattern": r"o3-mini.*", "provider": "openai", "input_price": 1.10, "output_price": 4.40},
    {"model_name": "claude-3.5-sonnet", "match_pattern": r"claude-3[\.-]5-sonnet.*", "provider": "anthropic", "input_price": 3.00, "output_price": 15.00},
    {"model_name": "claude-3.5-haiku", "match_pattern": r"claude-3[\.-]5-haiku.*", "provider": "anthropic", "input_price": 0.80, "output_price": 4.00},
    {"model_name": "claude-3-opus", "match_pattern": r"claude-3-opus.*", "provider": "anthropic", "input_price": 15.00, "output_price": 75.00},
    {"model_name": "gemini-2.0-flash", "match_pattern": r"gemini-2\.0-flash.*", "provider": "google", "input_price": 0.10, "output_price": 0.40},
    {"model_name": "gemini-2.5-pro", "match_pattern": r"gemini-2\.5-pro.*", "provider": "google", "input_price": 1.25, "output_price": 10.00},
    {"model_name": "gemini-2.5-flash", "match_pattern": r"gemini-2\.5-flash.*", "provider": "google", "input_price": 0.15, "output_price": 0.60},
    {"model_name": "command-r-plus", "match_pattern": r"command-r-plus.*", "provider": "cohere", "input_price": 2.50, "output_price": 10.00},
    {"model_name": "command-r", "match_pattern": r"command-r(?!\-plus).*", "provider": "cohere", "input_price": 0.50, "output_price": 1.50},
]


def find_matching_model(
    session: Session, model_identifier: str, project: str = "__global__"
) -> ModelDefinitionDB | None:
    all_models = session.exec(
        select(ModelDefinitionDB)
        .where(
            (ModelDefinitionDB.project == project)
            | (ModelDefinitionDB.project == "__global__")
        )
    ).all()

    for model_def in all_models:
        try:
            # Use search (not fullmatch) so provider-prefixed model names from
            # routers like OpenRouter (e.g. "google/gemini-2.5-flash-lite") still
            # match pricing patterns like "gemini-2\.5-flash.*".
            if re.search(model_def.match_pattern, model_identifier, re.IGNORECASE):
                return model_def
        except re.error:
            if model_def.match_pattern == model_identifier:
                return model_def

    return None


def calculate_cost(
    model_def: ModelDefinitionDB,
    prompt_tokens: int | None,
    completion_tokens: int | None,
    cached_tokens: int | None = None,
) -> float | None:
    if prompt_tokens is None or completion_tokens is None:
        return None

    input_cost = prompt_tokens * model_def.input_price
    if cached_tokens and model_def.cached_input_price is not None:
        input_cost = (
            (prompt_tokens - cached_tokens) * model_def.input_price
            + cached_tokens * model_def.cached_input_price
        )

    output_cost = completion_tokens * model_def.output_price
    return round((input_cost + output_cost) / 1_000_000, 8)


def calculate_cost_for_model(
    session: Session,
    model_identifier: str,
    prompt_tokens: int | None,
    completion_tokens: int | None,
    cached_tokens: int | None = None,
    project: str = "__global__",
) -> float | None:
    model_def = find_matching_model(session, model_identifier, project)
    if model_def is None:
        return None
    return calculate_cost(model_def, prompt_tokens, completion_tokens, cached_tokens)


def seed_default_models(session: Session, project: str = "__global__") -> int:
    created = 0
    for model_data in DEFAULT_MODELS:
        existing = session.exec(
            select(ModelDefinitionDB).where(
                ModelDefinitionDB.project == project,
                ModelDefinitionDB.model_name == model_data["model_name"],
            )
        ).first()

        if existing is None:
            model_def = ModelDefinitionDB(
                project=project,
                model_name=cast(str, model_data["model_name"]),
                match_pattern=cast(str, model_data["match_pattern"]),
                provider=cast(str, model_data["provider"]),
                input_price=cast(float, model_data["input_price"]),
                output_price=cast(float, model_data["output_price"]),
                cached_input_price=cast(float | None, model_data.get("cached_input_price")),
            )
            session.add(model_def)
            created += 1

    session.commit()
    return created
