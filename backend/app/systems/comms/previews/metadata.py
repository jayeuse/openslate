"""Streaming HTML parsing extracts plain text only; it never loads subordinate resources."""

from html.parser import HTMLParser
from typing import Any

LIMITS = {"title": 256, "description": 1024, "site_name": 128}
_IGNORED = {"script", "style", "template", "noscript", "iframe", "object", "svg"}


class _Text(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.ignored: list[str] = []
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _IGNORED:
            self.ignored.append(tag)

    def handle_endtag(self, tag: str) -> None:
        if self.ignored and tag == self.ignored[-1]:
            self.ignored.pop()

    def handle_data(self, data: str) -> None:
        if not self.ignored:
            self.parts.append(data)


def plain(value: str, limit: int) -> str:
    parser = _Text()
    parser.feed(value)
    parser.close()
    text = "".join(parser.parts)
    text = "".join(char for char in text if char.isprintable() or char.isspace())
    return " ".join(text.split())[:limit]


class _Metadata(_Text):
    def __init__(self) -> None:
        super().__init__()
        self.in_title = False
        self.title: list[str] = []
        self.values: dict[str, str] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        super().handle_starttag(tag, attrs)
        if self.ignored:
            return
        if tag == "title":
            self.in_title = True
        if tag == "meta":
            attributes = dict(attrs)
            name = (attributes.get("property") or attributes.get("name") or "").lower()
            content = attributes.get("content")
            if name in {"og:title", "og:description", "description", "og:site_name"} and content:
                self.values.setdefault(name, content)

    def handle_endtag(self, tag: str) -> None:
        super().handle_endtag(tag)
        if tag == "title":
            self.in_title = False

    def handle_data(self, data: str) -> None:
        if self.in_title and not self.ignored:
            self.title.append(data)


def extract(url: str, html: str) -> dict[str, str] | None:
    parser = _Metadata()
    parser.feed(html)
    parser.close()
    result = {
        "url": url,
        "title": plain(parser.values.get("og:title") or "".join(parser.title), LIMITS["title"]),
        "description": plain(
            parser.values.get("og:description") or parser.values.get("description", ""),
            LIMITS["description"],
        ),
        "site_name": plain(parser.values.get("og:site_name", ""), LIMITS["site_name"]),
    }
    return result if any(result[key] for key in LIMITS) else None


def validated(value: Any, url: str) -> dict[str, str] | None:
    if not isinstance(value, dict) or set(value) != {"url", *LIMITS} or value["url"] != url:
        return None
    if not all(
        isinstance(value[key], str)
        and len(value[key]) <= limit
        and plain(value[key], limit) == value[key]
        for key, limit in LIMITS.items()
    ):
        return None
    if not any(value[key] for key in LIMITS):
        return None
    return {"url": url, **{key: value[key] for key in LIMITS}}
