"""RFC 6238 TOTP codes for the real-provider MFA journeys."""

import base64
import hashlib
import hmac
import struct
from time import time


def totp(secret: str, offset: int = 0) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8), casefold=True)
    digest = hmac.new(key, struct.pack(">Q", int(time() + offset) // 30), hashlib.sha1).digest()
    index = digest[-1] & 15
    number = (struct.unpack(">I", digest[index : index + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return f"{number:06d}"
