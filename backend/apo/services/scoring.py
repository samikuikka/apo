"""
Scoring service for observation-level and trace-level scores.

Handles score validation, creation, and storage using existing
CallMetricDB (observation-level) and RunMetricDB (trace-level) models.
"""

from sqlmodel import Session, col, select

from ..models.db import CallMetricDB, RunMetricDB, ScoreConfigDB


def validate_score_against_config(
    session: Session,
    config_id: int,
    value: float,
    string_value: str | None = None,
) -> str | None:
    """
    Validate a score value against its ScoreConfig.

    Returns an error message if validation fails, or None if valid.
    """
    config = session.get(ScoreConfigDB, config_id)
    if config is None:
        return f"Score config {config_id} not found"

    if config.data_type == "NUMERIC":
        if config.min_value is not None and value < config.min_value:
            return f"Score {value} below minimum {config.min_value}"
        if config.max_value is not None and value > config.max_value:
            return f"Score {value} above maximum {config.max_value}"

    elif config.data_type == "CATEGORICAL":
        if config.categories is None:
            return "Categorical config has no categories defined"
        check_value = string_value if string_value is not None else str(value)
        category_keys = list(config.categories.keys())
        if check_value not in category_keys:
            return f"Value '{check_value}' not in categories: {category_keys}"

    elif config.data_type == "BOOLEAN":
        if value not in (0.0, 1.0, True, False):
            return f"Boolean score must be 0/1, got {value}"

    return None


def _coerce_score_value(
    value: float | str | bool | None,
    data_type: str,
) -> tuple[float | None, str | None]:
    """Coerce a raw score value into (numeric score, string value) per data type."""
    if value is None:
        return None, None
    if data_type == "CATEGORICAL":
        string_value = str(value)
        score_value = float(value) if isinstance(value, (int, float)) else None
        return score_value, string_value
    if data_type == "BOOLEAN":
        if isinstance(value, bool):
            return 1.0 if value else 0.0, None
        return float(value), None
    return float(value), None


def _validate_config_or_raise(
    session: Session,
    config_id: int,
    score_value: float | None,
    string_value: str | None,
) -> None:
    """Validate a coerced score against its ScoreConfig, raising ValueError on failure."""
    if score_value is not None:
        error = validate_score_against_config(
            session, config_id, score_value, string_value
        )
    elif string_value is not None:
        error = validate_score_against_config(session, config_id, 0.0, string_value)
    else:
        error = None
    if error:
        raise ValueError(error)


def record_score(
    session: Session,
    target: tuple[str, str],
    name: str,
    value: float | str | bool | None,
    data_type: str = "NUMERIC",
    source: str = "API",
    config_id: int | None = None,
    comment: str | None = None,
    project: str = "default",
) -> RunMetricDB | CallMetricDB:
    """Record a score against a trace or observation.

    Single source of truth for score creation: owns value coercion
    (NUMERIC / CATEGORICAL / BOOLEAN), config validation, and persistence.
    `target` is a ``(kind, id)`` pair where kind is ``"trace"`` or ``"observation"``.

    ``project`` scopes the metric row so two Projects sharing an OTel id cannot
    overwrite each other's score (SPEC-133 M4).
    """
    kind, target_id = target
    if kind not in ("trace", "observation"):
        raise ValueError(f"Invalid score target kind: {kind!r}")

    score_value, string_value = _coerce_score_value(value, data_type)

    if config_id is not None:
        _validate_config_or_raise(session, config_id, score_value, string_value)

    if kind == "trace":
        metric: RunMetricDB | CallMetricDB = RunMetricDB(
            run_id=target_id,
            project=project,
            metric_name=name,
            metric_type="quality",
            score=score_value,
            string_value=string_value,
            data_type=data_type,
            source=source,
            config_id=config_id,
            reasoning=comment,
        )
    else:
        metric = CallMetricDB(
            call_id=target_id,
            project=project,
            metric_name=name,
            metric_type="quality",
            score=score_value,
            string_value=string_value,
            data_type=data_type,
            source=source,
            config_id=config_id,
            reasoning=comment,
        )

    session.add(metric)
    session.commit()
    session.refresh(metric)
    return metric


def create_trace_score(
    session: Session,
    trace_id: str,
    name: str,
    value: float | str | bool | None,
    project: str = "default",
    data_type: str = "NUMERIC",
    source: str = "API",
    config_id: int | None = None,
    comment: str | None = None,
) -> RunMetricDB:
    """Create a score at the trace (run) level.

    Validates against ScoreConfig if config_id is provided.
    """
    metric = record_score(
        session,
        ("trace", trace_id),
        name=name,
        value=value,
        data_type=data_type,
        source=source,
        config_id=config_id,
        comment=comment,
        project=project,
    )
    assert isinstance(metric, RunMetricDB)
    return metric


def create_observation_score(
    session: Session,
    observation_id: str,
    name: str,
    value: float | str | bool | None,
    project: str = "default",
    data_type: str = "NUMERIC",
    source: str = "API",
    config_id: int | None = None,
    comment: str | None = None,
) -> CallMetricDB:
    """Create a score at the observation (call/span) level.

    Validates against ScoreConfig if config_id is provided.
    """
    metric = record_score(
        session,
        ("observation", observation_id),
        name=name,
        value=value,
        data_type=data_type,
        source=source,
        config_id=config_id,
        comment=comment,
        project=project,
    )
    assert isinstance(metric, CallMetricDB)
    return metric


def get_scores_for_trace(
    session: Session, trace_id: str, project: str = "default"
) -> list[RunMetricDB]:
    """Get all scores for a trace (run), scoped by Project."""
    return list(
        session.exec(
            select(RunMetricDB).where(
                RunMetricDB.run_id == trace_id, col(RunMetricDB.project) == project
            )
        ).all()
    )
