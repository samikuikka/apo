"""
Comment management API for traces and observations.

Supports creating, listing, deleting comments, and toggling emoji reactions.
"""

# pyright: reportCallInDefaultInitializer=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportAttributeAccessIssue=false, reportUnknownVariableType=false

import uuid
from collections.abc import Sequence

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session, select, func

from ..db import get_session
from ..models.db import CommentDB, CommentReactionDB
from ..services.demo_workspace import require_project_not_demo

router = APIRouter(prefix="/api/v1", tags=["comments"])


@router.get("/comments")
async def list_comments(
    object_id: str = Query(...),
    object_type: str = Query(...),
    session: Session = Depends(get_session),
) -> list[dict[str, object]]:
    """List all comments for a given object (trace or observation)."""
    comments = session.exec(
        select(CommentDB)
        .where(CommentDB.object_id == object_id)
        .where(CommentDB.object_type == object_type)
        .order_by(CommentDB.created_at.asc())  # type: ignore[union-attr]
    ).all()

    result: list[dict[str, object]] = []
    for c in comments:
        reactions = session.exec(
            select(CommentReactionDB).where(
                CommentReactionDB.comment_id == c.id
            )
        ).all()
        result.append(_comment_to_dict(c, list(reactions)))
    return result


@router.post("/comments", status_code=201)
async def create_comment(
    body: dict[str, object],
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Create a new comment on a trace or observation."""
    object_id = body.get("object_id")
    object_type = body.get("object_type")
    content = body.get("content")
    project_id = body.get("project_id", "")

    require_project_not_demo(str(project_id) if project_id else None)

    if not object_id or not object_type or not content:
        raise HTTPException(
            status_code=400,
            detail="object_id, object_type, and content are required",
        )

    if not isinstance(content, str) or not content.strip():
        raise HTTPException(status_code=400, detail="content must not be empty")

    mentioned = body.get("mentioned_user_ids")

    # Inline-comment selection anchor (all optional; absent for whole-object
    # comments). These are stored verbatim — the frontend computes them.
    selection_field = body.get("selection_field")
    selection_path = body.get("selection_path")
    selection_range_start = body.get("selection_range_start")
    selection_range_end = body.get("selection_range_end")
    selected_text = body.get("selected_text")

    has_selection = bool(selection_field and selection_path)
    comment = CommentDB(
        id=str(uuid.uuid4()),
        project_id=str(project_id),
        object_id=str(object_id),
        object_type=str(object_type),
        content=content.strip(),
        author_id=str(body.get("author_id", "")) or None,
        author_name=str(body.get("author_name", "")) or None,
        parent_comment_id=str(body.get("parent_comment_id", "")) or None,
        mentioned_user_ids=mentioned if isinstance(mentioned, list) else None,  # type: ignore[arg-type]
        selection_field=str(selection_field) if has_selection else None,
        selection_path=selection_path if isinstance(selection_path, list) else None,  # type: ignore[arg-type]
        selection_range_start=selection_range_start  # type: ignore[arg-type]
        if isinstance(selection_range_start, list)
        else None,
        selection_range_end=selection_range_end  # type: ignore[arg-type]
        if isinstance(selection_range_end, list)
        else None,
        selected_text=str(selected_text) if has_selection else None,
    )
    session.add(comment)
    session.commit()
    session.refresh(comment)
    return _comment_to_dict(comment, [])


@router.delete("/comments/{comment_id}", status_code=204)
async def delete_comment(
    comment_id: str,
    session: Session = Depends(get_session),
) -> None:
    """Delete a comment by ID. Only the author should delete."""
    comment = session.exec(
        select(CommentDB).where(CommentDB.id == comment_id)
    ).first()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")

    require_project_not_demo(comment.project_id)

    reactions = session.exec(
        select(CommentReactionDB).where(
            CommentReactionDB.comment_id == comment_id
        )
    ).all()
    for r in reactions:
        session.delete(r)
    session.delete(comment)
    session.commit()


@router.post("/comments/{comment_id}/reactions")
async def toggle_reaction(
    comment_id: str,
    body: dict[str, object],
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """Toggle an emoji reaction on a comment. If exists, remove it. If not, add it."""
    comment = session.exec(
        select(CommentDB).where(CommentDB.id == comment_id)
    ).first()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")

    require_project_not_demo(comment.project_id)

    emoji = body.get("emoji")
    user_id = body.get("user_id")
    if not emoji or not user_id:
        raise HTTPException(
            status_code=400, detail="emoji and user_id are required"
        )

    existing = session.exec(
        select(CommentReactionDB).where(
            CommentReactionDB.comment_id == comment_id,
            CommentReactionDB.emoji == str(emoji),
            CommentReactionDB.user_id == str(user_id),
        )
    ).first()

    if existing:
        session.delete(existing)
    else:
        session.add(
            CommentReactionDB(
                comment_id=comment_id,
                emoji=str(emoji),
                user_id=str(user_id),
            )
        )

    session.commit()

    all_reactions = session.exec(
        select(CommentReactionDB).where(
            CommentReactionDB.comment_id == comment_id
        )
    ).all()
    return _comment_to_dict(comment, list(all_reactions))


@router.get("/comments/counts")
async def get_comment_counts(
    object_ids: str = Query(..., description="Comma-separated object IDs"),
    object_type: str = Query(...),
    session: Session = Depends(get_session),
) -> dict[str, int]:
    """Get comment counts for multiple objects at once."""
    ids = [oid.strip() for oid in object_ids.split(",") if oid.strip()]
    if not ids:
        return {}

    rows = session.exec(
        select(CommentDB.object_id, func.count())
        .where(CommentDB.object_id.in_(ids))  # type: ignore[union-attr]
        .where(CommentDB.object_type == object_type)
        .group_by(CommentDB.object_id)
    ).all()

    counts = {oid: 0 for oid in ids}
    for row in rows:
        counts[row[0]] = row[1]
    return counts


def _comment_to_dict(
    comment: CommentDB, reactions: Sequence[CommentReactionDB]
) -> dict[str, object]:
    """Convert a CommentDB row to a JSON-serializable dict."""
    emoji_groups: dict[str, list[str]] = {}
    for r in reactions:
        if r.emoji not in emoji_groups:
            emoji_groups[r.emoji] = []
        emoji_groups[r.emoji].append(r.user_id)

    return {
        "id": comment.id,
        "project_id": comment.project_id,
        "object_id": comment.object_id,
        "object_type": comment.object_type,
        "content": comment.content,
        "author_id": comment.author_id,
        "author_name": comment.author_name,
        "parent_comment_id": comment.parent_comment_id,
        "mentioned_user_ids": comment.mentioned_user_ids,
        "selection_field": comment.selection_field,
        "selection_path": comment.selection_path,
        "selection_range_start": comment.selection_range_start,
        "selection_range_end": comment.selection_range_end,
        "selected_text": comment.selected_text,
        "reactions": [
            {"emoji": emoji, "user_ids": uids}
            for emoji, uids in emoji_groups.items()
        ],
        "created_at": comment.created_at.isoformat() if comment.created_at else None,
        "updated_at": comment.updated_at.isoformat() if comment.updated_at else None,
    }
