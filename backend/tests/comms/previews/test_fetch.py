"""SSRF and streaming behavior at the real HTTP parser / controlled DNS-and-socket boundary."""

import gzip
import socket
import zlib

import pytest

from tests.comms.previews.conftest import answer, response

URL = "https://preview.example.com:8443/owned?q=one#fragment"
LIMIT = 512 * 1024


def fetch(url=URL):
    from app.systems.comms.previews.fetch import fetch_metadata

    return fetch_metadata(url)


def test_verified_https_pins_the_address_but_preserves_host_and_sni(wire):
    result = fetch()
    assert result == {"url": URL, "title": "Owned title", "description": "", "site_name": ""}
    assert len(wire.resolutions) == len(wire.connections) == 1
    assert wire.resolver_policies == [(socket.AF_UNSPEC, socket.SOCK_STREAM, socket.IPPROTO_TCP, 0)]
    assert wire.connections[0].destination == ("93.184.216.34", 8443)
    assert wire.tls == ["preview.example.com"]
    request = b"".join(wire.connections[0].sent)
    assert b"GET /owned?q=one HTTP/1.1\r\n" in request
    assert b"Host: preview.example.com:8443\r\n" in request
    assert b"fragment" not in request


@pytest.mark.parametrize(
    "url,address,family",
    [
        ("http://1.1.1.1/owned", "1.1.1.1", socket.AF_INET),
        ("https://[2606:4700:4700::1111]/owned", "2606:4700:4700::1111", socket.AF_INET6),
    ],
)
def test_public_literal_addresses_never_need_hostname_resolution(wire, url, address, family):
    assert fetch(url) is not None
    assert wire.resolutions == []
    assert wire.connections[0].family == family
    assert wire.connections[0].destination[0] == address
    assert bool(wire.tls) == url.startswith("https:")


@pytest.mark.parametrize(
    "url",
    [
        "",
        "/relative",
        "//preview.example.com/path",
        "file:///etc/passwd",
        "gopher://preview.example.com/",
        "ftp://preview.example.com/",
        "data:text/html,hello",
        "javascript:alert(1)",
        "https://name:password@preview.example.com/",
        "https://name@preview.example.com/",
        "https://preview.example.com\\@127.0.0.1/",
        "https://preview.example.com\r\nHost:other/",
        "\nhttps://preview.example.com/",
        "https://preview.example.com:0/",
        "https://preview.example.com:65536/",
        "https://preview.example.com:wrong/",
        "http://[fe80::1%25eth0]/",
        "https://%31%32%37.0.0.1/",
        "http://2130706433/",
        "http://0x7f000001/",
        "http://127.1/",
        "http://0177.0.0.1/",
        "http://0x7f.0.0.1/",
        "http://0x7f.0x0.0x0.0x1/",
        "http://localhost/",
        "http://metadata.google.internal/",
        "http://metadata.amazonaws.com/",
        "https://preview.example.com/" + "a" * 2048,
    ],
)
def test_invalid_or_ambiguous_url_is_refused_before_any_socket(wire, url):
    assert fetch(url) is None
    assert wire.connections == []


@pytest.mark.parametrize(
    "address",
    [
        "0.0.0.0",
        "10.0.0.1",
        "127.0.0.1",
        "169.254.169.254",
        "169.254.0.1",
        "172.16.1.2",
        "192.168.0.1",
        "100.64.0.1",
        "100.100.100.200",
        "168.63.129.16",
        "192.0.0.9",
        "192.88.99.2",
        "198.18.0.1",
        "192.0.2.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "240.0.0.1",
        "255.255.255.255",
        "::",
        "::1",
        "::ffff:127.0.0.1",
        "::ffff:8.8.8.8",
        "fc00::1",
        "fd00:ec2::254",
        "fe80::1",
        "fec0::1",
        "ff02::1",
        "2001:db8::1",
        "2002:a00:1::",
        "2001::1",
        "2001:1::1",
        "64:ff9b::a00:1",
        "64:ff9b:1::1",
        "100::1",
    ],
)
def test_non_public_or_transition_dns_answers_are_refused(wire, address):
    wire.answers = [answer(address)]
    assert fetch() is None
    assert wire.connections == []


@pytest.mark.parametrize(
    "addresses",
    [
        ["93.184.216.34", "127.0.0.1"],
        ["127.0.0.1", "93.184.216.34"],
        ["93.184.216.34", "fd00::1"],
        ["2606:4700:4700::1111", "169.254.169.254"],
        [],
    ],
)
def test_every_dns_answer_must_pass_before_selecting_one(wire, addresses):
    wire.answers = [answer(value) for value in addresses]
    assert fetch() is None and wire.connections == []


def test_public_ipv6_dns_uses_the_original_hostname_and_unicode_names_are_canonical(wire):
    wire.answers = [answer("2606:4700:4700::1111")]
    result = fetch("https://bücher.example.com/Über")
    assert result is not None and result["url"] == "https://xn--bcher-kva.example.com/%C3%9Cber"
    assert wire.connections[0].destination[0] == "2606:4700:4700::1111"
    assert wire.tls == ["xn--bcher-kva.example.com"]
    assert b"Host: xn--bcher-kva.example.com\r\n" in b"".join(wire.connections[0].sent)


@pytest.mark.parametrize(
    "records",
    [
        [answer("93.184.216.34")] * 17,
        [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("not-an-ip", 443))],
        [
            (
                socket.AF_INET6,
                socket.SOCK_STREAM,
                socket.IPPROTO_TCP,
                "",
                ("93.184.216.34", 443, 0, 0),
            )
        ],
        [
            (
                socket.AF_INET6,
                socket.SOCK_STREAM,
                socket.IPPROTO_TCP,
                "",
                ("2606:4700:4700::1111", 443, 0, 2),
            )
        ],
    ],
)
def test_oversized_or_ambiguous_dns_result_sets_are_refused(wire, records):
    wire.answers = records
    assert fetch() is None and wire.connections == []


def test_dns_rebinding_is_not_an_unchecked_connect_lookup_and_next_fetch_resolves_again(wire):
    assert fetch() is not None
    assert len(wire.resolutions) == 1
    wire.answers = [answer("127.0.0.1")]
    assert fetch() is None
    assert len(wire.resolutions) == 2 and len(wire.connections) == 1


@pytest.mark.parametrize("failure", ["dns", "connect", "certificate", "peer"])
def test_failure_or_peer_mismatch_never_falls_back_to_another_destination(wire, failure):
    if failure == "peer":
        wire.peer = "127.0.0.1"
    else:
        setattr(wire, failure + "_failure", True)
    assert fetch() is None
    assert len(wire.resolutions) == 1 and len(wire.connections) <= 1
    assert all(connection.closed for connection in wire.connections)


@pytest.mark.parametrize("status", [301, 302, 303, 304, 307, 308, 401, 500])
def test_redirects_and_non_success_statuses_never_yield_metadata_or_another_request(wire, status):
    wire.replies = [response(status=status, headers=[("Location", "http://169.254.169.254/")])]
    assert fetch() is None
    assert len(wire.connections) == len(wire.resolutions) == 1


def test_proxy_environment_and_private_request_context_are_not_sent(wire, monkeypatch, caplog):
    for name in (
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ):
        monkeypatch.setenv(name, "http://proxy-user:proxy-password@127.0.0.1:9999")
    monkeypatch.setenv("NO_PROXY", "")
    secret_url = "https://preview.example.com/private?token=synthetic-url-canary"
    wire.replies = [response(b"<title>synthetic-title-canary</title>")]
    with caplog.at_level("DEBUG"):
        assert fetch(secret_url) is not None
    sent = b"".join(wire.connections[0].sent).lower()
    assert wire.connections[0].destination[0] == "93.184.216.34"
    assert not any(
        header in sent
        for header in (
            b"proxy-authorization:",
            b"authorization:",
            b"cookie:",
            b"x-org:",
            b"referer:",
        )
    )
    assert "synthetic-url-canary" not in caplog.text and "synthetic-title-canary" not in caplog.text


@pytest.mark.parametrize("extra", [0, 1])
@pytest.mark.parametrize("encoding", ["identity", "gzip", "deflate"])
def test_encoded_and_decoded_stream_bound_is_inclusive_without_partial_success(
    wire, extra, encoding
):
    title = b"<title>Boundary</title>"
    body = title + b" " * (LIMIT + extra - len(title))
    encoded = (
        gzip.compress(body)
        if encoding == "gzip"
        else zlib.compress(body)
        if encoding == "deflate"
        else body
    )
    wire.replies = [response(encoded, headers=[("Content-Encoding", encoding)])]
    result = fetch()
    assert (result is not None) == (extra == 0)
    if result is not None:
        assert result["title"] == "Boundary"


@pytest.mark.parametrize(
    "mode",
    [
        "oversize-declared",
        "truncated",
        "no-length-overflow",
        "duplicate-length",
        "bad-length",
        "unsupported-encoding",
        "stacked-encoding",
        "truncated-gzip",
        "concatenated-gzip",
        "wrong-type",
    ],
)
def test_malformed_or_unbounded_response_is_not_a_successful_prefix(wire, mode):
    body = b"<title>Must not escape</title>"
    headers = []
    length = False
    if mode == "oversize-declared":
        headers = [("Content-Length", str(LIMIT + 1))]
    elif mode == "truncated":
        headers = [("Content-Length", str(len(body) + 30))]
    elif mode == "no-length-overflow":
        body += b" " * LIMIT
    elif mode == "duplicate-length":
        headers = [("Content-Length", str(len(body))), ("Content-Length", str(len(body) + 1))]
    elif mode == "bad-length":
        headers = [("Content-Length", "-1")]
    elif mode == "unsupported-encoding":
        headers = [("Content-Encoding", "br")]
    elif mode == "stacked-encoding":
        headers = [("Content-Encoding", "gzip, deflate")]
    elif mode == "truncated-gzip":
        body = gzip.compress(body)[:-4]
        headers = [("Content-Encoding", "gzip")]
    elif mode == "concatenated-gzip":
        body = gzip.compress(body) + gzip.compress(b"extra")
        headers = [("Content-Encoding", "gzip")]
    elif mode == "wrong-type":
        wire.replies = [
            b"HTTP/1.1 200 OK\r\nContent-Type: image/svg+xml\r\nConnection: close\r\n\r\n" + body
        ]
        assert fetch() is None
        return
    wire.replies = [response(body, headers=headers, length=length)]
    assert fetch() is None


def test_chunked_content_is_counted_after_transfer_framing(wire):
    body = b"<title>Chunked</title>" + b" " * LIMIT
    chunked = f"{len(body):x}\r\n".encode() + body + b"\r\n0\r\n\r\n"
    wire.replies = [response(chunked, headers=[("Transfer-Encoding", "chunked")], length=False)]
    assert fetch() is None


def test_character_decoding_cannot_expand_the_accepted_text_budget(wire):
    prefix = b"<title>Character expansion</title>"
    body = prefix + b"\xff" * (LIMIT - len(prefix))
    wire.replies = [
        b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=iso-8859-1\r\n"
        + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode()
        + body
    ]
    assert fetch() is None


def test_entire_operation_deadline_does_not_reset_for_each_phase(wire):
    wire.dns_seconds, wire.connect_seconds, wire.tls_seconds, wire.read_seconds = 2, 1, 1, 1.1
    assert fetch() is None
    assert wire.now >= 5 and all(item.closed for item in wire.connections)


def test_html_produces_only_plain_bounded_metadata_and_never_subfetches(wire):
    wire.replies = [
        response(b"""<!doctype html SYSTEM "http://127.0.0.1/">
      <title>Fallback</title><meta property="og:title" content="Owned &amp; title">
      <meta name="description" content="A &lt;b&gt;description&lt;/b&gt;">
      <meta property="og:site_name" content="Example">
      <meta property="og:url" content="http://127.0.0.1/other">
      <meta property="og:image" content="http://127.0.0.1/image">
      <meta http-equiv="refresh" content="0;url=http://127.0.0.1/">
      <script>script-canary</script><img src="http://127.0.0.1/image">""")
    ]
    assert fetch() == {
        "url": URL,
        "title": "Owned & title",
        "description": "A description",
        "site_name": "Example",
    }
    assert len(wire.connections) == len(wire.resolutions) == 1
    wire.replies = [
        response(
            (
                "<title>"
                + "x" * 300
                + "</title><meta name='description' content='"
                + "d" * 1500
                + "'><meta property='og:site_name' content='"
                + "s" * 200
                + "'>"
            ).encode()
        )
    ]
    result = fetch()
    assert result is not None
    assert tuple(len(result[key]) for key in ("title", "description", "site_name")) == (
        256,
        1024,
        128,
    )
    wire.replies = [response(b"<h1>No metadata</h1><script><title>Not a title</title></script>")]
    assert fetch() is None


def test_url_selection_is_bounded_and_does_not_fetch_code_examples():
    from app.systems.comms.previews.urls import first_url

    assert first_url("No URL") is None
    assert (
        first_url("`https://preview.example.com/code` and ```https://preview.example.com/fence```")
        is None
    )
    assert (
        first_url("[owned](https://preview.example.com/a_(b)) then https://other.example.com/")
        == "https://preview.example.com/a_(b)"
    )
    assert first_url("https://name:password@preview.example.com/") is None
