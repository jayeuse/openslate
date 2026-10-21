"""Conservative public HTTP(S) targets; no DNS or I/O during message admission."""

import ipaddress
import re
import unicodedata
from dataclasses import dataclass
from urllib.parse import quote, urlsplit, urlunsplit

Address = ipaddress.IPv4Address | ipaddress.IPv6Address
MAX_URL_BYTES = 2048
_PROTOCOL_V4 = tuple(ipaddress.ip_network(value) for value in ("192.0.0.0/24", "192.88.99.0/24"))
_GLOBAL_V6 = ipaddress.ip_network("2000::/3")
_TRANSITION_V6 = tuple(ipaddress.ip_network(value) for value in ("2001::/23", "2002::/16"))
_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
_NUMBER = re.compile(r"(?:[0-9]+|0x[0-9a-f]+)\Z", re.IGNORECASE)
_CODE = re.compile(r"```[\s\S]*?(?:```|$)|`[^`\n]*(?:`|\n|$)|^ {4}.*$", re.MULTILINE)
_URL = re.compile(r"https?://[^\s<>\"`]+", re.IGNORECASE)


@dataclass(frozen=True)
class Target:
    url: str
    scheme: str
    host: str
    port: int
    authority: str
    path: str
    literal: Address | None


def public_address(value: str) -> Address | None:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return None
    if (
        not address.is_global
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
        or address.is_loopback
        or address.is_link_local
    ):
        return None
    if isinstance(address, ipaddress.IPv4Address):
        if address == ipaddress.ip_address("168.63.129.16") or any(
            address in net for net in _PROTOCOL_V4
        ):
            return None
    elif (
        address not in _GLOBAL_V6
        or address.is_site_local
        or address.ipv4_mapped is not None
        or any(address in net for net in _TRANSITION_V6)
    ):
        return None
    return address


def target(value: str) -> Target | None:
    try:
        if (
            not value
            or len(value.encode("utf-8")) > MAX_URL_BYTES
            or "\\" in value
            or any(ord(char) < 33 or ord(char) == 127 or char.isspace() for char in value)
        ):
            return None
        parsed = urlsplit(value)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or "@" in parsed.netloc
        ):
            return None
        host = unicodedata.normalize("NFC", parsed.hostname.lower())
        if "%" in host or host.endswith(".."):
            return None
        host = host.removesuffix(".")
        literal = None
        try:
            ipaddress.ip_address(host)
        except ValueError:
            original = host
            host = host.encode("idna").decode("ascii").lower()
            # Refuse lossy authority mappings, rather than guessing between URL parsers.
            if host.encode("ascii").decode("idna").lower() != original:
                return None
            labels = host.split(".")
            if (
                len(host) > 253
                or len(labels) < 2
                or any(not _LABEL.fullmatch(label) for label in labels)
                or labels[-1].isdigit()
                or all(_NUMBER.fullmatch(label) for label in labels)
                or host in {"metadata.amazonaws.com", "metadata.google.internal"}
                or host.endswith(
                    (".localhost", ".local", ".localdomain", ".internal", ".home.arpa", ".onion")
                )
            ):
                return None
        else:
            literal = public_address(host)
            if literal is None:
                return None
            host = str(literal)
        port = parsed.port if parsed.port is not None else (443 if parsed.scheme == "https" else 80)
        if not 1 <= port <= 65535:
            return None
        authority = f"[{host}]" if ":" in host else host
        if port != (443 if parsed.scheme == "https" else 80):
            authority += f":{port}"
        path = quote(parsed.path or "/", safe="/%:@!$&'()*+,;=-._~")
        query = quote(parsed.query, safe="/%?:@!$&'()*+,;=-._~")
        fragment = quote(parsed.fragment, safe="/%?:@!$&'()*+,;=-._~")
        canonical = urlunsplit((parsed.scheme, authority, path, query, fragment))
        if len(canonical.encode()) > MAX_URL_BYTES:
            return None
        return Target(
            canonical,
            parsed.scheme,
            host,
            port,
            authority,
            path + ("?" + query if query else ""),
            literal,
        )
    except (ValueError, UnicodeError):
        return None


def first_url(body: str) -> str | None:
    for match in _URL.finditer(_CODE.sub(" ", body)):
        value = match.group().rstrip(".,!?;:")
        while value.endswith(")") and value.count(")") > value.count("("):
            value = value[:-1]
        candidate = target(value)
        if candidate is not None:
            return candidate.url
    return None
