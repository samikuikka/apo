"""Webhook delivery service: sign payloads, deliver with retry, track failures."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import secrets
from collections.abc import Mapping
from datetime import datetime, timezone

import httpx
from sqlmodel import Session, select

from ..db import engine
from ..models.db import WebhookDB

logger = logging.getLogger(__name__)

MAX_CONSECUTIVE_FAILURES = 10
DELIVERY_TIMEOUT_SECONDS = 10
MAX_RETRIES = 2


def sign_payload(payload: bytes, secret: str) -> str:
    mac = hmac.new(secret.encode(), payload, hashlib.sha256)
    return f"sha256={mac.hexdigest()}"


def verify_signature(payload: bytes, secret: str, signature: str) -> bool:
    expected = sign_payload(payload, secret)
    return hmac.compare_digest(expected, signature)


def generate_secret() -> str:
    return f"whsec_{secrets.token_hex(24)}"


async def deliver_webhook(webhook: WebhookDB, event_data: Mapping[str, object]) -> bool:
    assert webhook.id is not None

    payload_bytes = json.dumps(event_data, default=str).encode()
    signature = sign_payload(payload_bytes, webhook.secret)

    headers = {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
        "X-Webhook-Event": str(event_data.get("event_type", "")),
        "X-Webhook-Delivery-ID": f"{webhook.id}-{event_data.get('timestamp', '')}",
    }

    async with httpx.AsyncClient(timeout=DELIVERY_TIMEOUT_SECONDS) as client:
        for attempt in range(MAX_RETRIES + 1):
            try:
                resp = await client.post(
                    webhook.url, content=payload_bytes, headers=headers
                )
                if 200 <= resp.status_code < 300:
                    _update_webhook_status(webhook.id, success=True)
                    return True
                logger.warning(
                    "Webhook %s returned %s (attempt %d)",
                    webhook.id,
                    resp.status_code,
                    attempt + 1,
                )
            except httpx.HTTPError as exc:
                logger.warning(
                    "Webhook %s delivery failed (attempt %d): %s",
                    webhook.id,
                    attempt + 1,
                    exc,
                )
            if attempt < MAX_RETRIES:
                await asyncio.sleep(1)

    _update_webhook_status(webhook.id, success=False)
    return False


def _update_webhook_status(webhook_id: int, success: bool) -> None:
    with Session(engine) as session:
        wh = session.get(WebhookDB, webhook_id)
        if wh is None:
            return
        wh.last_delivery_at = datetime.now(timezone.utc)
        wh.last_delivery_status = "success" if success else "failure"
        if success:
            wh.consecutive_failures = 0
        else:
            wh.consecutive_failures += 1
            if wh.consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                wh.enabled = False
                logger.warning(
                    "Webhook %s disabled after %d consecutive failures",
                    wh.id,
                    wh.consecutive_failures,
                )
        session.add(wh)
        session.commit()


async def fire_webhooks_for_event(
    project: str,
    event: object,
) -> None:
    event_type = getattr(event, "event_type", "")
    event_data = {
        "event_type": getattr(event, "event_type", ""),
        "project": getattr(event, "project", ""),
        "data": getattr(event, "data", {}),
        "timestamp": getattr(event, "timestamp", datetime.now(timezone.utc)).isoformat(),
    }

    with Session(engine) as session:
        statement = select(WebhookDB).where(
            WebhookDB.project == project,
            WebhookDB.enabled == True,  # noqa: E712
        )
        webhooks = session.exec(statement).all()

    matching = [
        wh for wh in webhooks if not wh.events or event_type in wh.events
    ]

    for wh in matching:
        try:
            await deliver_webhook(wh, event_data)
        except Exception:
            logger.exception("Webhook delivery error for webhook %s", wh.id)
