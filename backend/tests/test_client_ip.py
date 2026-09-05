# pyright: reportAny=false, reportExplicitAny=false, reportPrivateUsage=false

from starlette.requests import Request

from apo.auth.client_ip import get_client_ip


def _request(peer: str, forwarded_for: str | None = None) -> Request:
    headers: list[tuple[bytes, bytes]] = []
    if forwarded_for is not None:
        headers.append((b"x-forwarded-for", forwarded_for.encode()))
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/",
        "query_string": b"",
        "headers": headers,
        "client": (peer, 1234),
    }
    return Request(scope)


class TestGetClientIpTrustedProxy:
    def test_ignores_forwarded_for_from_public_peer(self) -> None:
        req = _request("203.0.113.5", "198.51.100.1")
        assert get_client_ip(req) == "203.0.113.5"

    def test_honors_forwarded_for_from_loopback_peer(self) -> None:
        req = _request("127.0.0.1", "198.51.100.1")
        assert get_client_ip(req) == "198.51.100.1"

    def test_honors_forwarded_for_from_private_peer(self) -> None:
        req = _request("172.18.0.5", "198.51.100.1")
        assert get_client_ip(req) == "198.51.100.1"

    def test_first_forwarded_hop_wins(self) -> None:
        req = _request("10.0.0.5", "198.51.100.7, 10.0.0.5")
        assert get_client_ip(req) == "198.51.100.7"

    def test_no_header_returns_socket_peer(self) -> None:
        req = _request("203.0.113.5", None)
        assert get_client_ip(req) == "203.0.113.5"

    def test_unparseable_peer_is_never_trusted(self) -> None:
        req = _request("testclient", "198.51.100.1")
        assert get_client_ip(req) == "testclient"

    def test_env_overrides_trusted_ranges(self, monkeypatch) -> None:  # type: ignore[no-untyped-def]
        monkeypatch.setenv("APO_TRUSTED_PROXY_RANGES", "192.0.2.0/24")
        untrusted = _request("10.0.0.5", "198.51.100.1")
        assert get_client_ip(untrusted) == "10.0.0.5"

        trusted = _request("192.0.2.10", "198.51.100.1")
        assert get_client_ip(trusted) == "198.51.100.1"

    def test_env_empty_value_falls_back_to_defaults(self, monkeypatch) -> None:  # type: ignore[no-untyped-def]
        monkeypatch.setenv("APO_TRUSTED_PROXY_RANGES", "")
        req = _request("172.18.0.5", "198.51.100.1")
        assert get_client_ip(req) == "198.51.100.1"

    def test_malformed_cidr_entries_are_skipped(self, monkeypatch) -> None:  # type: ignore[no-untyped-def]
        monkeypatch.setenv("APO_TRUSTED_PROXY_RANGES", "not-a-cidr,10.0.0.0/8")
        req = _request("10.1.2.3", "198.51.100.1")
        assert get_client_ip(req) == "198.51.100.1"
