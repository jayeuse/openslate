"""Bounded generic SMTP transport for local one-time action links."""

from __future__ import annotations

import multiprocessing
import smtplib
import ssl
from dataclasses import dataclass
from email.message import EmailMessage
from multiprocessing.connection import Connection
from multiprocessing.process import BaseProcess
from typing import Protocol
from urllib.parse import urlsplit, urlunsplit

from app.core.config import Settings
from app.systems.access.identity.models import ActionTokenPurpose


class SMTPConnection(Protocol):
    def ehlo(self) -> object: ...

    def starttls(self, *, context: ssl.SSLContext) -> object: ...

    def login(self, user: str, password: str) -> object: ...

    def send_message(self, message: EmailMessage) -> object: ...

    def quit(self) -> object: ...


@dataclass(frozen=True, slots=True)
class SMTPDeliveryCommand:
    recipient: str
    purpose: ActionTokenPurpose
    raw_token: str
    host: str
    port: int
    username: str | None
    password: str | None
    sender: str
    transport: str
    socket_timeout_seconds: float
    public_origin: str


def send_delivery(
    recipient: str,
    purpose: ActionTokenPurpose,
    raw_token: str,
    settings: Settings,
    *,
    smtp_factory: type[smtplib.SMTP] = smtplib.SMTP,
    smtp_ssl_factory: type[smtplib.SMTP_SSL] = smtplib.SMTP_SSL,
) -> None:
    """Send one message using bounded socket operations in the current process."""

    _send_command(
        _command(recipient, purpose, raw_token, settings),
        smtp_factory=smtp_factory,
        smtp_ssl_factory=smtp_ssl_factory,
    )


def send_delivery_bounded(
    recipient: str,
    purpose: ActionTokenPurpose,
    raw_token: str,
    settings: Settings,
) -> bool:
    """Enforce one delivery deadline in a child process.

    Action tokens and SMTP passwords cross only private multiprocessing pipes.
    They are absent from child arguments, environments, command lines, and logs.
    """

    command = _command(recipient, purpose, raw_token, settings)
    context = multiprocessing.get_context("spawn")
    command_receiver, command_sender = context.Pipe(duplex=False)
    result_receiver, result_sender = context.Pipe(duplex=False)
    child = context.Process(
        target=_delivery_child,
        args=(command_receiver, result_sender),
        name="openslate-smtp-delivery",
        daemon=True,
    )
    try:
        child.start()
        command_receiver.close()
        result_sender.close()
        command_sender.send(command)
        command_sender.close()
        if not result_receiver.poll(settings.smtp_delivery_operation_timeout_seconds):
            _stop_child(child)
            return False
        try:
            return bool(result_receiver.recv())
        except EOFError:
            return False
    except (OSError, RuntimeError):
        _stop_child(child)
        return False
    finally:
        command_sender.close()
        result_receiver.close()
        if child.is_alive():
            _stop_child(child)
        else:
            child.join(timeout=0)


def _delivery_child(command_receiver: Connection, result_sender: Connection) -> None:
    try:
        command = command_receiver.recv()
        if not isinstance(command, SMTPDeliveryCommand):
            raise ValueError("Invalid SMTP command")
        _send_command(command)
    except Exception:
        result_sender.send(False)
    else:
        result_sender.send(True)
    finally:
        command_receiver.close()
        result_sender.close()


def _stop_child(child: BaseProcess) -> None:
    if child.is_alive():
        child.terminate()
        child.join(timeout=1)
    if child.is_alive():
        child.kill()
        child.join(timeout=1)


def _command(
    recipient: str, purpose: ActionTokenPurpose, raw_token: str, settings: Settings
) -> SMTPDeliveryCommand:
    if (
        settings.smtp_host is None
        or settings.smtp_port is None
        or settings.smtp_from is None
        or settings.smtp_transport is None
    ):
        raise RuntimeError("SMTP settings are unavailable")
    return SMTPDeliveryCommand(
        recipient=recipient,
        purpose=purpose,
        raw_token=raw_token,
        host=settings.smtp_host,
        port=settings.smtp_port,
        username=settings.smtp_username,
        password=(
            settings.smtp_password.get_secret_value()
            if settings.smtp_password is not None
            else None
        ),
        sender=settings.smtp_from,
        transport=settings.smtp_transport,
        socket_timeout_seconds=settings.smtp_timeout_seconds,
        public_origin=settings.public_origin,
    )


def _send_command(
    command: SMTPDeliveryCommand,
    *,
    smtp_factory: type[smtplib.SMTP] = smtplib.SMTP,
    smtp_ssl_factory: type[smtplib.SMTP_SSL] = smtplib.SMTP_SSL,
) -> None:
    message = EmailMessage()
    message["From"] = command.sender
    message["To"] = command.recipient
    message["Subject"] = _subject(command.purpose)
    message.set_content(_body(command.purpose, command.raw_token, command.public_origin))
    connection = _connect(command, smtp_factory=smtp_factory, smtp_ssl_factory=smtp_ssl_factory)
    try:
        if command.username is not None and command.password is not None:
            connection.login(command.username, command.password)
        connection.send_message(message)
    finally:
        try:
            connection.quit()
        except (OSError, smtplib.SMTPException):
            pass


def _connect(
    command: SMTPDeliveryCommand,
    *,
    smtp_factory: type[smtplib.SMTP],
    smtp_ssl_factory: type[smtplib.SMTP_SSL],
) -> SMTPConnection:
    if command.transport == "implicit_tls":
        return smtp_ssl_factory(
            command.host,
            command.port,
            timeout=command.socket_timeout_seconds,
            context=ssl.create_default_context(),
        )
    connection = smtp_factory(command.host, command.port, timeout=command.socket_timeout_seconds)
    connection.ehlo()
    if command.transport == "starttls":
        connection.starttls(context=ssl.create_default_context())
        connection.ehlo()
    return connection


def _subject(purpose: ActionTokenPurpose) -> str:
    if purpose == ActionTokenPurpose.INVITATION:
        return "Complete your OpenSlate setup"
    return "Reset your OpenSlate password"


def _body(purpose: ActionTokenPurpose, raw_token: str, public_origin: str) -> str:
    path = "/auth/setup" if purpose == ActionTokenPurpose.INVITATION else "/auth/recovery"
    parsed = urlsplit(public_origin)
    origin = urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))
    link = f"{origin}{path}#token={raw_token}"
    if purpose == ActionTokenPurpose.INVITATION:
        return f"Open this one-time link to set your OpenSlate password:\n\n{link}\n"
    return f"Open this one-time link to reset your OpenSlate password:\n\n{link}\n"
