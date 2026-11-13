"""Restore the platform's proxy bypass list for provider endpoints.

`httpx(trust_env=True)` derives its proxy map from `urllib.request.getproxies()`.
On macOS that reader returns the System Configuration proxy hosts but drops the
accompanying ExceptionsList, so a system proxy also captures the traffic the OS
itself declares direct. Pointing a provider at a local runtime — Ollama on
`http://127.0.0.1:11434/v1`, vLLM on a LAN address — then yields the proxy's
answer (commonly HTTP 502, since proxies refuse loopback targets) instead of the
model's, even though macOS lists `127.0.0.1` as an exception.

`*_PROXY` environment variables have the same gap, and reach it in a worse way.
The shell snippet that exports them commonly omits `no_proxy` — a bare
`export http_proxy=… https_proxy=… all_proxy=socks5://…` — so nothing exempts a
loopback endpoint, and httpx dutifully asks the proxy for it. The platform's
exception list is then the operator's only statement about direct hosts, so this
module honors it here too.

`STEERABLE_EGRESS_CONFINED=1` is what keeps that from widening confinement. The
desktop sets it beside the proxy variables when it confines the sidecar's egress
to its per-host proxy, and deliberately not on the startup-failure fallback. It
marks a declaration that owns every host, exception list included; under it no
endpoint is exempted, which also keeps `web_fetch`'s confined-mode error honest.
Without the marker, proxy variables are ambient host configuration, and the OS's
own exception list qualifies them.

One more wrinkle: httpx honors `NO_PROXY` only once a client exists. It builds a
transport for every declared proxy while constructing the client, so a scheme it
cannot build raises there, before any URL is matched — and no `mounts` entry
avoids it. `all_proxy=socks5://…` does this without the `socks` extra installed
(which the sidecar declares, so it takes a broken install to see). An exempt
endpoint therefore drops the environment's proxy map wholesale rather than pin a
mount; a proxied endpoint keeps the error, since going direct would be exactly
the silent proxy bypass the declaration forbids.

Every bypass decision comes from `urllib.request`, which implements each
platform's own matching rules (macOS ExceptionsList with CIDR and wildcard
entries, the Windows registry, `no_proxy` elsewhere). Reading it costs a System
Configuration round trip, so results are memoized per host: a proxy change mid
-session takes effect on the next sidecar boot.
"""

from __future__ import annotations

import importlib.util
import os
import urllib.request
from collections.abc import Callable, Mapping
from functools import lru_cache
from typing import NamedTuple
from urllib.parse import urlsplit, urlunsplit

#: The desktop sets this alongside the proxy variables when it confines the
#: sidecar's egress to its per-host proxy, and never on the startup-failure
#: fallback. Its presence marks a proxy declaration that owns every host,
#: including the ones the OS calls direct.
_EGRESS_CONFINED_ENV = "STEERABLE_EGRESS_CONFINED"

# Proxy schemes httpx can only serve through an optional dependency. Declaring a
# scheme from this map without its package installed makes client construction
# raise, so the endpoint's own bypass status decides whether that is fatal.
_OPTIONAL_PROXY_SCHEMES = {"socks5": "socksio", "socks5h": "socksio", "socks4": "socksio"}


@lru_cache(maxsize=128)
def _platform_list_says_direct(host: str) -> bool:
    """Whether the OS's own exception list declares `host` direct.

    `urllib.request.proxy_bypass` answers from `no_proxy` alone as soon as any
    proxy environment variable is set, so it cannot report the platform list in
    the one branch that needs it. These readers are the platform-specific
    functions it would otherwise delegate to; absent both, there is no platform
    opinion to add beyond the `no_proxy` reading the caller already has.
    """
    reader = getattr(urllib.request, "proxy_bypass_macosx_sysconf", None) or getattr(
        urllib.request, "proxy_bypass_registry", None
    )
    if reader is None:
        return False
    try:
        return bool(reader(host))
    except Exception:
        return False


@lru_cache(maxsize=128)
def _platform_says_direct(host: str) -> bool:
    try:
        return bool(urllib.request.proxy_bypass(host))
    except Exception:
        # Reading proxy configuration must never fail a request: an
        # unavailable `_scproxy`, a registry error, or a malformed
        # `no_proxy` all mean "no opinion", which is httpx's own default.
        return False


def _pin_direct(host: str) -> dict[str, None]:
    """httpx `mounts` sending every scheme on `host` straight out."""
    pattern = f"[{host}]" if ":" in host else host
    return {f"all://{pattern}": None}


def direct_mounts(
    base_url: str,
    *,
    env_proxies: Callable[[], Mapping[str, str]] = urllib.request.getproxies_environment,
    platform_bypass: Callable[[str], bool] = _platform_says_direct,
) -> dict[str, None] | None:
    """httpx `mounts` pinning `base_url` to a direct connection, or None.

    None means "no override": either the environment declares the proxy, or the
    platform has no bypass opinion about this host.
    """
    if env_proxies():
        return None
    host = urlsplit(base_url).hostname
    if not host or not platform_bypass(host):
        return None
    return _pin_direct(host)


@lru_cache(maxsize=1)
def _platform_proxies() -> tuple[tuple[str, str], ...]:
    """The platform's own proxy map, read once per process.

    `urllib.request.getproxies` reaches System Configuration on macOS and the
    registry on Windows; a failure report must not pay that round trip on
    every request.
    """
    try:
        return tuple(
            (key, value) for key, value in urllib.request.getproxies().items() if value
        )
    except Exception:
        return ()


def _egress_is_confined() -> bool:
    return (os.environ.get(_EGRESS_CONFINED_ENV) or "").strip() == "1"


def _unbuildable_proxy_schemes(
    proxies: Mapping[str, str],
    *,
    has_module: Callable[[str], bool],
) -> set[str]:
    """Declared proxy schemes whose httpx transport cannot be constructed."""
    missing = set()
    for url in proxies.values():
        scheme = urlsplit(url).scheme.lower()
        package = _OPTIONAL_PROXY_SCHEMES.get(scheme)
        if package and not has_module(package):
            missing.add(scheme)
    return missing


class EgressPath(NamedTuple):
    """How a provider request to `base_url` leaves this process.

    `proxy` is the client-side proxy address without credentials, or None for a
    direct connection. It is what a failure report shows: the address alone
    tells the reader which hop to inspect, while credentials would leak into
    logs and copied diagnostics.
    """

    proxy: str | None

    @property
    def uses_proxy(self) -> bool:
        return self.proxy is not None


def _redacted_proxy_url(value: str) -> str:
    """Proxy URL without userinfo; a bare `host:port` is returned as written."""
    candidate = value if "://" in value else f"http://{value}"
    parts = urlsplit(candidate)
    host = parts.netloc.rpartition("@")[2]
    return urlunsplit((parts.scheme, host, parts.path, "", ""))


def _proxy_for_scheme(
    proxies: Mapping[str, str],
    *,
    scheme: str,
    env_bypass: Callable[[str], bool],
    platform_list_bypass: Callable[[str], bool],
    host: str | None,
) -> str | None:
    """The declared proxy `host` would use, or None when it is exempt."""
    if host and (env_bypass(host) or platform_list_bypass(host)):
        return None
    for key in (scheme, "all"):
        declared = proxies.get(key)
        if declared:
            return _redacted_proxy_url(declared)
    return None


def egress_path(
    base_url: str,
    *,
    env_proxies: Callable[[], Mapping[str, str]] = urllib.request.getproxies_environment,
    platform_proxies: Callable[[], Mapping[str, str]] = lambda: dict(_platform_proxies()),
    platform_bypass: Callable[[str], bool] = _platform_says_direct,
    env_bypass: Callable[[str], bool] = urllib.request.proxy_bypass_environment,
    platform_list_bypass: Callable[[str], bool] = _platform_list_says_direct,
    confined: Callable[[], bool] = _egress_is_confined,
) -> EgressPath:
    """Which hop a request to `base_url` takes, for failure reports.

    Mirrors `client_env_kwargs` rather than re-deciding: environment proxies
    first, the platform's own proxy map when the environment declares none
    (httpx reads `getproxies()` under `trust_env`), the confinement marker,
    and the two bypass lists. It answers only what a report should show.
    """
    host = urlsplit(base_url).hostname
    scheme = urlsplit(base_url).scheme or "https"
    proxies = env_proxies()
    if not proxies:
        if direct_mounts(
            base_url, env_proxies=lambda: proxies, platform_bypass=platform_bypass
        ):
            return EgressPath(proxy=None)
        proxies = platform_proxies()
    if confined():
        declared = next(iter(proxies.values()), "")
        return EgressPath(proxy=_redacted_proxy_url(declared) if declared else None)
    return EgressPath(
        proxy=_proxy_for_scheme(
            proxies,
            scheme=scheme,
            env_bypass=env_bypass,
            platform_list_bypass=platform_list_bypass,
            host=host,
        )
    )


def _direct_pin_or_trust_env(
    base_url: str,
    proxies: Mapping[str, str],
    *,
    has_module: Callable[[str], bool],
) -> dict[str, None] | None:
    """A direct pin for `base_url`, or None when the pin cannot be built.

    httpx builds a transport for every declared proxy while constructing the
    client, so one unbuildable scheme fails the whole client no matter which
    pattern the request matches. When that happens the caller must fall back to
    `trust_env=False`, which is the only way to keep this host out of a proxy
    map that cannot be assembled.
    """
    host = urlsplit(base_url).hostname
    if not host:
        return None
    if proxies and _unbuildable_proxy_schemes(proxies, has_module=has_module):
        return None
    return _pin_direct(host)


def client_env_kwargs(
    base_url: str,
    *,
    force_direct: bool = False,
    env_proxies: Callable[[], Mapping[str, str]] = urllib.request.getproxies_environment,
    platform_bypass: Callable[[str], bool] = _platform_says_direct,
    env_bypass: Callable[[str], bool] = urllib.request.proxy_bypass_environment,
    platform_list_bypass: Callable[[str], bool] = _platform_list_says_direct,
    confined: Callable[[], bool] = _egress_is_confined,
    has_module: Callable[[str], bool] = lambda name: importlib.util.find_spec(name) is not None,
) -> dict[str, object]:
    """`httpx.AsyncClient` keyword arguments for reaching `base_url`.

    Returns `mounts` pinning `base_url` to a direct connection when a proxy
    declaration would otherwise capture a host its own configuration calls
    direct, or `trust_env=False` when that pin cannot work because httpx fails to
    build one of the declared proxies. `trust_env=False` also stops httpx from
    reading netrc and the SSL env vars, so it is reserved for that case, where
    the alternative is not a degraded client but no client at all.

    An empty dict leaves httpx's own environment handling untouched: the endpoint
    is proxied as declared, or confined egress owns every host.

    `force_direct` overrides all of that for one endpoint: the user asked this
    model service to connect directly, typically after a proxy turned a working
    connection into a timeout. It cannot override confined egress — that
    declaration owns every host, and the host's own sandbox decides reachability
    — so it resolves to `trust_env=False` there, which is what keeps the
    per-host egress proxy out of the request.
    """
    if force_direct:
        pinned = _direct_pin_or_trust_env(base_url, env_proxies(), has_module=has_module)
        return {"trust_env": False} if pinned is None else {"mounts": pinned}
    proxies = env_proxies()
    if not proxies:
        mounts = direct_mounts(
            base_url, env_proxies=lambda: proxies, platform_bypass=platform_bypass
        )
        return {"mounts": mounts} if mounts else {}
    if confined():
        return {}
    host = urlsplit(base_url).hostname
    if not host or not (env_bypass(host) or platform_list_bypass(host)):
        return {}
    if _unbuildable_proxy_schemes(proxies, has_module=has_module):
        # Pinning this host direct would not help: httpx builds a transport for
        # every declared proxy, so the unbuildable one raises regardless of which
        # pattern the request matches.
        return {"trust_env": False}
    return {"mounts": _pin_direct(host)}
