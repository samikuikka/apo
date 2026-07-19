import pytest
from source import calculate_discount, process_order, format_receipt, InventoryTracker


class TestCalculateDiscount:
    def test_basic_discount(self):
        assert calculate_discount(100, 10) == 90.0

    def test_max_discount_cap(self):
        assert calculate_discount(100, 80) == 50.0

    def test_zero_discount(self):
        assert calculate_discount(100, 0) == 100.0

    def test_negative_price_raises(self):
        with pytest.raises(ValueError):
            calculate_discount(-10, 10)


class TestProcessOrder:
    def test_regular_customer(self):
        items = [{"name": "widget", "quantity": 2, "price": 10.0}]
        result = process_order(items)
        assert result["item_count"] == 1
        assert result["subtotal"] == 20.0

    def test_premium_customer_gets_discount(self):
        items = [{"name": "widget", "quantity": 2, "price": 10.0}]
        result = process_order(items, customer_type="premium")
        assert result["subtotal"] < 20.0

    def test_empty_order(self):
        result = process_order([])
        assert result["subtotal"] == 0.0


class TestInventoryTracker:
    def test_add_and_get(self):
        tracker = InventoryTracker()
        tracker.add_item("widget", 10, 5.0)
        assert tracker.get_stock("widget") == 10

    def test_remove(self):
        tracker = InventoryTracker()
        tracker.add_item("widget", 10, 5.0)
        assert tracker.remove_item("widget", 3) is True
        assert tracker.get_stock("widget") == 7

    def test_remove_nonexistent(self):
        tracker = InventoryTracker()
        assert tracker.remove_item("widget", 1) is False
