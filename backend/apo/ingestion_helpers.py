from typing import cast


def _get_str(body: dict[str, object], key: str, default: str) -> str:
    value = body.get(key)
    return value if isinstance(value, str) else default


def _get_optional_str(body: dict[str, object], key: str) -> str | None:
    value = body.get(key)
    return value if isinstance(value, str) else None


def _get_optional_int(body: dict[str, object], key: str) -> int | None:
    value = body.get(key)
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return None


def _get_optional_float(body: dict[str, object], key: str) -> float | None:
    value = body.get(key)
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _get_string_list(body: dict[str, object], key: str) -> list[str]:
    value = body.get(key)
    if isinstance(value, list):
        return [item for item in cast(list[object], value) if isinstance(item, str)]
    return []


def _get_json_map(body: dict[str, object], key: str) -> dict[str, object]:
    value = body.get(key)
    if isinstance(value, dict):
        return dict(cast(dict[str, object], value))
    return {}


def _get_optional_json_map(
    body: dict[str, object], key: str
) -> dict[str, object] | None:
    value = body.get(key)
    if isinstance(value, dict):
        return dict(cast(dict[str, object], value))
    return None
