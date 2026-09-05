"""Client-IP extraction for rate limiting and audit trails.

Pre-authentication endpoints (login, API-key bootstrap, hosted-access probes,
invitation acceptance) rate-limit and audit per source IP. Behind the docker
ingress the socket address is the proxy, so ``x-forwarded-for`` carries the
real client — but the header is client-controlled, and honoring it
unconditionally lets anyone reset their rate-limit bucket on every request by
sending a fresh spoofed value. The header is therefore only honored when the
direct socket peer sits inside a trusted proxy range
(``APO_TRUSTED_PROXY_RANGES``, comma-separated CIDRs).

The default trusts loopback and the private ranges docker networks use, so
the shipped ingress paths (Next.js rewrites, Caddy, cloudflared) keep
working while public peers are never trusted. Two caveins by design:

- Docker's published-port NAT rewrites the peer to the bridge gateway, which
  is private — for those deployments the ingress itself (Caddy
  ``trusted_proxies_strict``, the Cloudflare edge) remains the outer boundary
  that sanitizes the header.
- Setting ``APO_TRUSTED_PROXY_RANGES`` to a narrower value than the actual
  proxy topology collapses proxied clients onto the proxy's own IP and makes
  them share one rate-limit bucket.
"""

import ipaddress
import os

from fastapi import Request

_DEFAULT_TRUSTED_RANGES = (
    "127.0.0.0/8,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7"
)

type _TrustedNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network


def _trusted_networks() -> list[_TrustedNetwork]:
    raw = (
        os.environ.get("APO_TRUSTED_PROXY_RANGES", "").strip()
        or _DEFAULT_TRUSTED_RANGES
    )
    networks: list[_TrustedNetwork] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            networks.append(ipaddress.ip_network(part, strict=False))
        except ValueError:
            continue
    return networks


def _peer_is_trusted(peer: str) -> bool:
    try:
        addr = ipaddress.ip_address(peer)
    except ValueError:
        return False
    return any(addr in network for network in _trusted_networks())


def get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    peer = request.client.host if request.client else "unknown"
    if forwarded and _peer_is_trusted(peer):
        return forwarded.split(",")[0].strip()
    return peer
