"""Private invitation credentials and owned Mailpit email actions."""

from __future__ import annotations

import html
import ipaddress
import json
import os
import re
import secrets
import stat
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Literal
from urllib.parse import parse_qs, urlsplit

import httpx


class SampleInvitationError(RuntimeError):
    """A safe private-roster or invitation-delivery failure."""


class _InboxChanged(SampleInvitationError):
    """Mail arrived or was pruned between the pages of one inbox read."""


_PAGE_SIZE = 50
_MAX_PAGES = 20
_WAIT_SECONDS = 20.0
_TOKEN_HASH = re.compile(r"[0-9a-f]{56}\Z")


def _origin(value: str) -> str:
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        raise SampleInvitationError("Configured browser origin is invalid") from None
    if (
        parts.scheme.lower() not in {"http", "https"}
        or not parts.hostname
        or parts.username is not None
        or parts.password is not None
        or parts.path not in {"", "/"}
        or parts.query
        or parts.fragment
    ):
        raise SampleInvitationError("Configured browser origin must be an HTTP origin")
    hostname = parts.hostname.lower()
    if ":" in hostname:
        hostname = f"[{hostname}]"
    if (parts.scheme.lower(), port) in {("http", 80), ("https", 443)}:
        port = None
    authority = hostname if port is None else f"{hostname}:{port}"
    return f"{parts.scheme.lower()}://{authority}"


def _mailpit_url(value: str) -> str:
    try:
        parts = urlsplit(value)
        _ = parts.port
        host = parts.hostname
    except ValueError:
        raise SampleInvitationError("Owned Mailpit URL is invalid") from None
    try:
        loopback = host is not None and ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = host is not None and host.lower() == "localhost"
    if (
        parts.scheme.lower() not in {"http", "https"}
        or not loopback
        or parts.username is not None
        or parts.password is not None
        or parts.path not in {"", "/"}
        or parts.query
        or parts.fragment
    ):
        raise SampleInvitationError("Mailpit must be an owned loopback HTTP service URL")
    return f"{parts.scheme.lower()}://{parts.netloc}"


class CredentialRoster:
    """Owner-only credential file with atomic, durable progress updates."""

    def __init__(self, path: Path, document: dict[str, Any]) -> None:
        self.path = path
        self.document = document
        self.accounts = {row["key"]: row for row in document["accounts"]}

    @classmethod
    def create(cls, path: Path, accounts: Sequence[Mapping[str, str]]) -> CredentialRoster:
        target = Path(path).expanduser()
        if not target.is_absolute():
            raise SampleInvitationError("Credential roster path must be absolute")
        rows: list[dict[str, str]] = []
        passwords: set[str] = set()
        for source in accounts:
            row = {key: value for key, value in source.items()}
            row["state"] = "planned"
            if row["status"] != "pending":
                password = secrets.token_urlsafe(27)
                while password in passwords:
                    password = secrets.token_urlsafe(27)
                passwords.add(password)
                row["password"] = password
            rows.append(row)
        document: dict[str, Any] = {
            "format": "openslate-sample-people-v1",
            "accounts": rows,
            "groups": {},
            "last_operation": {"operation": "preflight", "state": "ready"},
        }
        instance = cls(target, document)
        instance._write(create=True)
        return instance

    def password(self, key: str) -> str:
        password = self.accounts[key].get("password")
        if not isinstance(password, str):
            raise SampleInvitationError("Pending invitations do not have passwords")
        return password

    def set_account(self, key: str, *, state: str, user_id: str | None = None) -> None:
        row = self.accounts[key]
        row["state"] = state
        if user_id is not None:
            row["user_id"] = user_id
        self._write()

    def set_group(self, key: str, *, group_id: str, state: str) -> None:
        self.document["groups"][key] = {"id": group_id, "state": state}
        self._write()

    def operation(self, operation: str, key: str, state: str) -> None:
        self.document["last_operation"] = {
            "operation": operation,
            "logical_key": key,
            "state": state,
        }
        self._write()

    def _write(self, *, create: bool = False) -> None:
        parent = self.path.parent
        try:
            parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            info = parent.stat()
            owner = os.getuid() if hasattr(os, "getuid") else info.st_uid
            if parent.is_symlink() or info.st_uid != owner or stat.S_IMODE(info.st_mode) & 0o077:
                raise SampleInvitationError("Credential roster directory must be owner-only")
            if create:
                if os.path.lexists(self.path):
                    raise SampleInvitationError("Private credential roster already exists")
                descriptor = os.open(
                    self.path,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                    0o600,
                )
                self._write_descriptor(descriptor)
                self._fsync_parent()
                return
            temporary = self.path.with_name(f".{self.path.name}.{secrets.token_hex(8)}.tmp")
            descriptor = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                0o600,
            )
            try:
                self._write_descriptor(descriptor)
                os.replace(temporary, self.path)
                self._fsync_parent()
            finally:
                if os.path.lexists(temporary):
                    os.unlink(temporary)
        except SampleInvitationError:
            raise
        except OSError:
            raise SampleInvitationError(
                "Unable to persist the owner-only credential roster"
            ) from None

    def _write_descriptor(self, descriptor: int) -> None:
        payload = (json.dumps(self.document, sort_keys=True, indent=2) + "\n").encode()
        with os.fdopen(descriptor, "wb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise SampleInvitationError("Credential roster must be a regular file")
            os.fchmod(stream.fileno(), 0o600)
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())

    def _fsync_parent(self) -> None:
        descriptor = os.open(self.path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


class InvitationMailbox:
    """Mailpit reader that consumes only new recipient-matched invite actions."""

    def __init__(self, url: str, origin: str) -> None:
        self.origin = _origin(origin)
        self.client = httpx.Client(
            base_url=_mailpit_url(url), timeout=5.0, trust_env=False, follow_redirects=False
        )

    def close(self) -> None:
        self.client.close()

    def __enter__(self) -> InvitationMailbox:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def snapshot(self) -> set[str]:
        ids = set()
        for message in self._settled_messages():
            message_id = message.get("ID")
            if not isinstance(message_id, str) or not message_id:
                raise SampleInvitationError("Mailpit returned a message without an ID")
            ids.add(message_id)
        return ids

    def invitation_token(self, baseline_ids: set[str], recipient: str) -> str:
        return self._action_token(baseline_ids, recipient, "invite")

    def recovery_token(self, baseline_ids: set[str], recipient: str) -> str:
        return self._action_token(baseline_ids, recipient, "recovery")

    def email_change_token(self, baseline_ids: set[str], recipient: str) -> str:
        return self._action_token(baseline_ids, recipient, "email_change")

    def _action_token(
        self,
        baseline_ids: set[str],
        recipient: str,
        kind: Literal["invite", "recovery", "email_change"],
    ) -> str:
        deadline = time.monotonic() + _WAIT_SECONDS
        while True:
            tokens: set[str] = set()
            for summary in self._settled_messages(deadline):
                message_id = summary.get("ID")
                if (
                    not isinstance(message_id, str)
                    or message_id in baseline_ids
                    or not self._recipient_matches(summary, recipient)
                ):
                    continue
                token = self._email_token(message_id, kind)
                if token:
                    tokens.add(token)
            if len(tokens) == 1:
                return next(iter(tokens))
            if len(tokens) > 1:
                raise SampleInvitationError("Multiple new email actions matched one recipient")
            if time.monotonic() >= deadline:
                raise SampleInvitationError("No new matching email action arrived before timeout")
            time.sleep(0.25)

    def _settled_messages(self, deadline: float | None = None) -> list[Mapping[str, Any]]:
        """Read the inbox again while it changes mid-read, until the deadline.

        Mailpit keeps at most 500 messages, so a full inbox changes its total
        whenever mail arrives or old mail is pruned.
        """
        until = time.monotonic() + _WAIT_SECONDS if deadline is None else deadline
        while True:
            try:
                return self._messages()
            except _InboxChanged:
                if time.monotonic() >= until:
                    raise
                time.sleep(0.25)

    def _messages(self) -> list[Mapping[str, Any]]:
        result: list[Mapping[str, Any]] = []
        total: int | None = None
        for page in range(_MAX_PAGES):
            start = page * _PAGE_SIZE
            try:
                response = self.client.get(
                    "/api/v1/messages", params={"start": start, "limit": _PAGE_SIZE}
                )
                response.raise_for_status()
                payload = response.json()
            except (httpx.HTTPError, ValueError):
                raise SampleInvitationError("Unable to read the owned Mailpit inbox") from None
            rows = payload.get("messages") if isinstance(payload, Mapping) else None
            count = payload.get("total") if isinstance(payload, Mapping) else None
            if (
                not isinstance(rows, list)
                or not all(isinstance(row, Mapping) for row in rows)
                or not isinstance(count, int)
                or isinstance(count, bool)
                or count < 0
                or len(rows) > _PAGE_SIZE
            ):
                raise SampleInvitationError("Mailpit returned an invalid message listing")
            if total is None:
                total = count
                if total > _PAGE_SIZE * _MAX_PAGES:
                    raise SampleInvitationError("Mailpit inbox exceeds the safe snapshot bound")
            elif count != total:
                raise _InboxChanged("Mailpit inbox changed during message pagination")
            result.extend(rows)
            if start + len(rows) >= total:
                return result
            if not rows:
                raise _InboxChanged("Mailpit pagination ended before the reported total")
        raise SampleInvitationError("Mailpit inbox exceeds the safe snapshot page count")

    @staticmethod
    def _recipient_matches(summary: Mapping[str, Any], recipient: str) -> bool:
        addresses = summary.get("To")
        return isinstance(addresses, list) and any(
            isinstance(address, Mapping)
            and isinstance(address.get("Address"), str)
            and address["Address"].strip().casefold() == recipient.strip().casefold()
            for address in addresses
        )

    def _email_token(
        self, message_id: str, kind: Literal["invite", "recovery", "email_change"]
    ) -> str | None:
        try:
            response = self.client.get(f"/api/v1/message/{message_id}")
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError):
            raise SampleInvitationError("Unable to read a new invitation email") from None
        body = payload.get("HTML") if isinstance(payload, Mapping) else None
        if not isinstance(body, str):
            return None
        links = re.findall(r'href\s*=\s*(?:"([^"]*)"|\'([^\']*)\')', body, re.I)
        for quoted, single in links:
            link = urlsplit(html.unescape(quoted or single))
            try:
                link_origin = _origin(f"{link.scheme}://{link.netloc}")
            except SampleInvitationError:
                continue
            expected_path = {
                "invite": "/auth/setup",
                "recovery": "/auth/recovery",
                "email_change": "/auth/email-change",
            }[kind]
            if link_origin != self.origin or link.path != expected_path or link.query:
                continue
            try:
                fields = parse_qs(link.fragment, strict_parsing=True, keep_blank_values=True)
            except ValueError:
                continue
            token_values = fields.get("token_hash", [])
            if (
                set(fields) == {"token_hash", "type"}
                and fields.get("type") == [kind]
                and len(token_values) == 1
                and _TOKEN_HASH.fullmatch(token_values[0])
            ):
                return token_values[0]
        return None
