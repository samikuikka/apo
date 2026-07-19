from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

import httpx

logger = logging.getLogger("apo_langchain")

type JsonMap = dict[str, object]


class IngestionClient:
    _endpoint: str
    _flush_threshold: int
    _timeout: float
    _client: httpx.Client

    def __init__(
        self,
        endpoint: str = "http://localhost:8000",
        flush_threshold: int = 10,
        timeout: float = 5.0,
    ) -> None:
        self._endpoint = endpoint.rstrip("/")
        self._flush_threshold = flush_threshold
        self._timeout = timeout
        self._queue: list[JsonMap] = []
        self._client = httpx.Client(timeout=timeout)

    def enqueue(self, event: JsonMap) -> None:
        self._queue.append(event)
        if len(self._queue) >= self._flush_threshold:
            self.flush()

    def flush(self) -> None:
        if not self._queue:
            return

        batch = self._queue[:]
        self._queue.clear()

        try:
            self._send_batch(batch)
        except Exception:
            logger.debug("Failed to send batch, re-enqueueing", exc_info=True)
            self._queue.extend(batch)

    def _send_batch(self, batch: list[JsonMap]) -> None:
        events = [
            {
                "id": str(uuid.uuid4()),
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "type": event["type"],
                "body": event["body"],
            }
            for event in batch
        ]

        url = f"{self._endpoint}/api/v1/ingestion"
        response = self._client.post(url, json={"batch": events})
        response.raise_for_status()

        data: dict[str, object] = response.json()
        processed = data.get("processed", 0)
        errors_raw: object = data.get("errors", [])
        if isinstance(errors_raw, list) and errors_raw:
            logger.warning(
                "Ingestion completed with %d errors out of %d events",
                len(errors_raw),
                len(batch),
            )
        else:
            logger.debug(
                "Ingestion successful: %d/%d events processed",
                processed,
                len(batch),
            )

    def close(self) -> None:
        self.flush()
        self._client.close()
