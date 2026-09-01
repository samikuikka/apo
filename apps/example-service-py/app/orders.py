"""Plain-service demo routes: an orders API with no agent involvement.

These routes exist to demonstrate **tracing without task runs**: a normal
service surface (list / fetch / create), auto-instrumented by OpenTelemetry,
exporting to apo like any company service would. Every request becomes a
trace; the attributes set here (`customer.tier`, `order.total`,
`http.response.status_code`) are exactly what apo's trace search filters on.

Routes:
  - ``GET  /api/orders``        list (``X-Customer-Tier`` header → attribute)
  - ``GET  /api/orders/{id}``   fetch (404 for unknown ids)
  - ``POST /api/orders``        create (422 invalid body; 500 when the item
                                names "fail" — simulating a provider outage)
"""

from __future__ import annotations

import random
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from opentelemetry import trace
from pydantic import BaseModel, Field, ValidationError

router = APIRouter(prefix="/api/orders", tags=["orders"])

# A tiny in-memory "database" — enough shape to be a believable service.
_ORDERS: dict[str, dict[str, Any]] = {
    "ord-1001": {"id": "ord-1001", "item": "keyboard", "total": 79.0, "tier": "enterprise"},
    "ord-1002": {"id": "ord-1002", "item": "monitor", "total": 429.0, "tier": "pro"},
    "ord-1003": {"id": "ord-1003", "item": "cable", "total": 9.5, "tier": "free"},
}

_tracer = trace.get_tracer("orders-api")


class CreateOrderRequest(BaseModel):
    item: str = Field(min_length=1, max_length=100)
    total: float = Field(gt=0, le=100_000)


@router.get("")
def list_orders(request: Request) -> JSONResponse:
    tier = request.headers.get("x-customer-tier", "free")
    with _tracer.start_as_current_span("db.query") as span:
        span.set_attribute("db.system", "sqlite")
        span.set_attribute("db.statement", "SELECT id, item, total FROM orders")
        rows = [o for o in _ORDERS.values() if o["tier"] == tier] or list(_ORDERS.values())
    # The request span (auto-instrumented) carries the tier — this is what
    # `attribute:customer.tier` predicates filter on in apo.
    trace.get_current_span().set_attribute("customer.tier", tier)
    return JSONResponse({"orders": rows, "count": len(rows)})


@router.get("/{order_id}")
def get_order(order_id: str) -> JSONResponse:
    order = _ORDERS.get(order_id)
    if order is None:
        return JSONResponse({"error": f"order {order_id} not found"}, status_code=404)
    return JSONResponse(order)


@router.post("")
async def create_order(request: Request) -> JSONResponse:
    body: dict[str, Any] = await request.json()
    tier = request.headers.get("x-customer-tier", "free")
    trace.get_current_span().set_attribute("customer.tier", tier)
    try:
        parsed = CreateOrderRequest.model_validate(body)
    except ValidationError as exc:
        # FastAPI/pydantic validation failure → 422 trace, searchable as
        # `http.response.status_code = 422`.
        return JSONResponse({"error": "invalid order", "detail": exc.errors()}, status_code=422)

    if "fail" in parsed.item.lower():
        # Simulated downstream provider outage → 500 with an exception event
        # on the span, exactly what a flaky payment provider looks like.
        raise RuntimeError(f"payment provider rejected item {parsed.item!r}")

    order_id = f"ord-{random.randint(2000, 9999)}"
    order = {"id": order_id, "item": parsed.item, "total": parsed.total, "tier": tier}
    _ORDERS[order_id] = order
    trace.get_current_span().set_attribute("order.total", parsed.total)
    return JSONResponse(order, status_code=201)
