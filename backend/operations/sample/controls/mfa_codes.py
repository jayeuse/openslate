"""Ephemeral codes and verification probes for owned MFA sample enrollments."""

import base64
import binascii
import hashlib
import hmac
import struct
from collections.abc import Callable

import httpx

from operations.sample.client import SampleClient
from operations.sample.phases.actions import SamplePhaseActionError, _read_json


def _totp(secret: str, timestamp: float) -> str:
    try:
        key = base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)
        digest = hmac.new(key, struct.pack(">Q", int(timestamp) // 30), hashlib.sha1).digest()
        index = digest[-1] & 15
        number = (struct.unpack(">I", digest[index : index + 4])[0] & 0x7FFFFFFF) % 1_000_000
        return f"{number:06d}"
    except (ValueError, binascii.Error):
        raise SamplePhaseActionError(
            "MFA enrollment material is invalid", step="mfa_verify"
        ) from None


def verify_totp_codes(
    request: Callable[..., httpx.Response],
    actor: str,
    prefix: str,
    client: SampleClient,
    factor: str,
    secret: str,
    timestamp: float,
) -> None:
    valid = {_totp(secret, max(0, timestamp + offset)) for offset in (-60, -30, 0, 30, 60)}
    wrong = next(f"{number:06d}" for number in range(6) if f"{number:06d}" not in valid)
    for suffix, code, status in (
        ("wrong_code", wrong, 400),
        ("verify", _totp(secret, timestamp), 200),
    ):
        step = f"{prefix}_{suffix}"
        response = request(
            actor,
            step,
            "POST",
            f"/api/auth/mfa/factors/{factor}/verification",
            status,
            client=client,
            body={"code": code},
        )
        body = _read_json(response, step=step)
        expected = (
            {"code": "mfa_verification_failed", "message": "Verification code was not accepted"}
            if status == 400
            else {"verified": True, "access_token": None}
        )
        if (body.get("detail") if status == 400 else body) != expected:
            raise SamplePhaseActionError(
                "MFA verification response differs from its contract", step=step
            )
