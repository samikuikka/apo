# pyright: reportAny=false, reportDeprecated=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false

"""Environment and label scoping for the Batch Run and Task Run lists.

A Batch carries a typed ``environment`` column and caller-defined labels in
``run_metadata.labels`` (``{"<key>": {"id": ..., "name": ...}}``, validated
at creation by ``validate_run_metadata``). Both lists filter on the Batch, so
a Task Run matches through the Batch it belongs to.

Labels are read straight from ``run_metadata`` with the dialect-neutral JSON
path operators SQLAlchemy renders for SQLite (``JSON_EXTRACT``) and Postgres
(``#>>``): ``run_metadata`` stays the single source of truth, so nothing has
to be kept in step on the many paths that create or purge Batches.
"""

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import cast

from sqlalchemy import func, select as sa_select
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import Session, col

from ..models import AgentTaskBatchRunDB
from ..models.columns import AGENT_TASK_BATCH_CREATED_AT_COL, AGENT_TASK_BATCH_PROJECT_COL
from ..models.schemas import (
    RUN_LABEL_KEY_RE,
    FacetBucket,
    RunLabelFacets,
    RunLabelFacetValue,
    RunLabelKeyFacet,
    run_labels_from_metadata,
)


def parse_label_filters(values: Sequence[str]) -> dict[str, list[str]]:
    """Parse repeated ``label=<key>:<id>`` query values into ``{key: [ids]}``.

    The id is everything after the first ``:``, so ids may contain colons.
    Raises ``ValueError`` on a malformed value — a filter that silently
    matched nothing would read as "no runs".
    """
    parsed: dict[str, list[str]] = {}
    for raw in values:
        key, sep, label_id = raw.partition(":")
        if not sep or not RUN_LABEL_KEY_RE.fullmatch(key) or not label_id:
            raise ValueError(
                f"label filter {raw!r} must be <key>:<id> with a key of letters, digits, '_' or '-'"
            )
        ids = parsed.setdefault(key, [])
        if label_id not in ids:
            ids.append(label_id)
    return parsed


def batch_scope_conditions(
    environments: Sequence[str],
    labels: Mapping[str, Sequence[str]],
) -> list[ColumnElement[bool]]:
    """WHERE conditions on ``agent_task_batch_runs`` for the two dimensions.

    Environments OR. Labels OR within a key and AND across keys, matching on
    the label ``id`` only — ``name`` is display and may change between runs.
    """
    conditions: list[ColumnElement[bool]] = []
    if environments:
        conditions.append(col(AgentTaskBatchRunDB.environment).in_(list(environments)))
    metadata = col(AgentTaskBatchRunDB.run_metadata)
    for key, ids in labels.items():
        if ids:
            conditions.append(
                metadata[("labels", key, "id")].as_string().in_(list(ids))
            )
    return conditions


@dataclass
class _LabelTally:
    name: str  # the newest Batch's name for this id
    count: int = 0


def compute_run_label_facets(session: Session, project_id: str) -> RunLabelFacets:
    """Distinct environments and label ids recorded on a project's Batches.

    Each label id carries the name of its most recent Batch, so a rename shows
    up once and the option keeps filtering the whole history. Counts are Batch
    Runs. Only the labels sub-document is fetched, and only from Batches that
    have one.
    """
    env_rows = session.execute(
        sa_select(col(AgentTaskBatchRunDB.environment), func.count())
        .where(AGENT_TASK_BATCH_PROJECT_COL == project_id)
        .group_by(col(AgentTaskBatchRunDB.environment))
    ).all()
    environments = sorted(
        (FacetBucket(value=env, count=count) for env, count in env_rows if env),
        key=lambda bucket: (-bucket.count, bucket.value),
    )

    labels_doc = col(AgentTaskBatchRunDB.run_metadata)["labels"].as_string()
    label_rows = session.execute(
        sa_select(labels_doc)
        .where(AGENT_TASK_BATCH_PROJECT_COL == project_id, labels_doc.is_not(None))
        .order_by(AGENT_TASK_BATCH_CREATED_AT_COL.desc())
    ).all()

    # key -> id -> tally; rows arrive newest first, so the first name wins.
    by_key: dict[str, dict[str, _LabelTally]] = {}
    for (raw,) in label_rows:
        try:
            document = cast(object, json.loads(raw))
        except (TypeError, ValueError):
            continue
        if not isinstance(document, dict):
            continue
        labels = run_labels_from_metadata({"labels": cast(dict[str, object], document)})
        for key, label in labels.items():
            by_key.setdefault(key, {}).setdefault(label.id, _LabelTally(label.name)).count += 1

    return RunLabelFacets(
        environments=environments,
        labels=[
            RunLabelKeyFacet(
                key=key,
                values=sorted(
                    (
                        RunLabelFacetValue(id=label_id, name=tally.name, count=tally.count)
                        for label_id, tally in values.items()
                    ),
                    key=lambda value: (value.name.lower(), value.id),
                ),
            )
            for key, values in sorted(by_key.items())
        ],
    )

