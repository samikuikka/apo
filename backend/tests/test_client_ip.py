# pyright: reportAny=false, reportExplicitAny=false, reportPrivateUsage=false

from starlette.requests import Request

from apo.auth.client_ip import get_client_ip, get_external_client_ip


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

    def test_whitespace_only_forwarded_for_falls_back_to_peer(self) -> None:
        # An empty first hop must not collapse every such visitor onto one
        # shared bucket key.
        req = _request("10.0.0.5", "  ")
        assert get_client_ip(req) == "10.0.0.5"

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


class TestGetExternalClientIp:
    """Which requests a per-address limit may key by a client address."""

    def test_public_peer_is_its_own_client_address(self) -> None:
        assert get_external_client_ip(_request("203.0.113.5", None)) == "203.0.113.5"

    def test_public_peer_cannot_borrow_a_forwarded_address(self) -> None:
        # A spoofed header from an untrusted peer must not mint a fresh
        # bucket per request: the socket address stays the key.
        req = _request("203.0.113.5", "198.51.100.1")
        assert get_external_client_ip(req) == "203.0.113.5"

    def test_trusted_peer_forwards_the_real_client(self) -> None:
        req = _request("172.18.0.5", "198.51.100.7, 172.18.0.2")
        assert get_external_client_ip(req) == "198.51.100.7"

    def test_trusted_peer_without_forwarded_address_is_the_installation_itself(
        self,
    ) -> None:
        # The dashboard server's own fetch: nothing sits between it and the
        # backend, so there is no client address to key a limit by. Keying by
        # the peer would put every visitor into that one container's bucket.
        assert get_external_client_ip(_request("172.18.0.5", None)) is None
        assert get_external_client_ip(_request("127.0.0.1", None)) is None

    def test_blank_forwarded_address_from_trusted_peer_is_not_a_client(self) -> None:
        assert get_external_client_ip(_request("10.0.0.5", "  ")) is None
        assert get_external_client_ip(_request("10.0.0.5", " , 198.51.100.7")) is None

    def test_unparseable_peer_is_attributable_by_its_own_name(self) -> None:
        # Not an IP, so never trusted, so never mistaken for the installation.
        assert get_external_client_ip(_request("testclient", None)) == "testclient"

    def test_narrowed_trusted_ranges_decide_who_counts_as_the_installation(
        self, monkeypatch
    ) -> None:  # type: ignore[no-untyped-def]
        monkeypatch.setenv("APO_TRUSTED_PROXY_RANGES", "192.0.2.0/24")
        assert get_external_client_ip(_request("10.0.0.5", None)) == "10.0.0.5"
        assert get_external_client_ip(_request("192.0.2.10", None)) is None
