"""Local password hashing and policy enforcement."""

from importlib.resources import files

from pwdlib import PasswordHash

_HASHER = PasswordHash.recommended()
_COMMON_PASSWORDS = frozenset(
    line.strip().casefold()
    for line in files("app.core.security").joinpath("common_passwords.txt").read_text().splitlines()
    if line.strip()
)


class PasswordPolicyError(ValueError):
    """A password does not meet the local identity policy."""


def validate_password(password: str) -> None:
    if not 12 <= len(password) <= 128:
        raise PasswordPolicyError("Password must be between 12 and 128 characters")
    if password.casefold() in _COMMON_PASSWORDS:
        raise PasswordPolicyError("Password is too common")


def hash_password(password: str) -> str:
    validate_password(password)
    return _HASHER.hash(password)


def verify_password(password: str, password_digest: str) -> bool:
    try:
        return _HASHER.verify(password, password_digest)
    except ValueError:
        return False
