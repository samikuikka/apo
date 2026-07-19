import json
from typing import Optional


def calculate_discount(
    price: float, discount_percent: float, max_discount: float = 50.0
) -> float:
    """Calculate discounted price."""
    if price < 0:
        raise ValueError("Price cannot be negative")

    if discount_percent > max_discount:
        discount_percent = max_discount

    discount = price * (discount_percent / 100)
    return price - discount


def process_order(items: list[dict], customer_type: str = "regular") -> dict:
    """Process a customer order and return order summary."""
    total = 0.0
    for item in items:
        qty = item.get("quantity", 1)
        price = item.get("price", 0)
        total += qty * price

    if customer_type == "premium":
        total = calculate_discount(total, 15)
    elif customer_type == "vip":
        total = calculate_discount(total, 25)

    tax = total * 0.21

    return {
        "subtotal": total,
        "tax": tax,
        "total": total + tax,
        "item_count": len(items),
    }


def format_receipt(order: dict) -> str:
    """Format order as receipt string."""
    lines = []
    lines.append("=" * 40)
    lines.append("RECEIPT")
    lines.append("=" * 40)
    lines.append(f"Items: {order['item_count']}")
    lines.append(f"Subtotal: ${order['subtotal']:.2f}")
    lines.append(f"Tax (21%): ${order['tax']:.2f}")
    lines.append(f"Total: ${order['total']:.2f}")
    lines.append("=" * 40)
    return "\n".join(lines)


def load_config(path: str) -> dict:
    """Load configuration from JSON file."""
    with open(path) as f:
        return json.load(f)


class InventoryTracker:
    def __init__(self):
        self.items = {}

    def add_item(self, name: str, quantity: int, price: float):
        if name in self.items:
            self.items[name]["quantity"] += quantity
        else:
            self.items[name] = {"quantity": quantity, "price": price}

    def get_stock(self, name: str) -> Optional[int]:
        if name in self.items:
            return self.items[name]["quantity"]
        return None

    def remove_item(self, name: str, quantity: int) -> bool:
        if name not in self.items:
            return False
        if self.items[name]["quantity"] < quantity:
            return False
        self.items[name]["quantity"] -= quantity
        if self.items[name]["quantity"] == 0:
            del self.items[name]
        return True
