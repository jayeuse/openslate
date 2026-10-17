"""Generate installation secrets without printing or invoking a shell."""

import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import sys
import time
from pathlib import Path
from typing import Any
from uuid import uuid4

import jwt
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.asymmetric import ec

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config.environment import ConfigurationError, read_environment

# FastAPI signs short-lived Realtime channel tokens with this key; only its public half
# joins JWT_JWKS. Realtime needs its own cookie/session base and a 16-byte AES-128 key.
REALTIME_KEYS = ("REALTIME_TOKEN_SIGNING_KEY", "REALTIME_SECRET_KEY_BASE", "REALTIME_DB_ENC_KEY")
_JWKS_LINE = re.compile(r"JWT_JWKS=")


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _opaque_key(prefix: str) -> str:
    # Match the pinned self-hosted gateway key format, without shell dependencies.
    intermediate = prefix + secrets.token_urlsafe(17)[:22]
    digest = hashlib.sha256(f"supabase-self-hosted|{intermediate}".encode()).digest()
    return intermediate + "_" + _base64url(digest)[:8]


def _signing_jwk() -> tuple[ec.EllipticCurvePrivateKey, dict[str, Any], dict[str, Any]]:
    private_key = ec.generate_private_key(ec.SECP256R1())
    private_jwk = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(private_key))
    private_jwk.update(
        kid=str(uuid4()), use="sig", key_ops=["sign", "verify"], alg="ES256", ext=True,
    )
    public_jwk = {key: value for key, value in private_jwk.items() if key != "d"}
    public_jwk["key_ops"] = ["verify"]
    return private_key, private_jwk, public_jwk


def realtime_secrets() -> tuple[dict[str, str], dict[str, Any]]:
    """Return the Realtime secrets and the public JWK that JWT_JWKS must carry."""

    _key, private_jwk, public_jwk = _signing_jwk()
    values = {
        "REALTIME_TOKEN_SIGNING_KEY": json.dumps(private_jwk, separators=(",", ":")),
        "REALTIME_SECRET_KEY_BASE": secrets.token_urlsafe(64),
        "REALTIME_DB_ENC_KEY": secrets.token_hex(8),
    }
    return values, public_jwk


def generate_secrets() -> dict[str, str]:
    """Return fresh self-hosted provider and application session keys."""
    private_key, private_jwk, public_jwk = _signing_jwk()
    realtime, realtime_public_jwk = realtime_secrets()
    jwt_secret = secrets.token_urlsafe(48)
    legacy_jwk = {"kty": "oct", "k": _base64url(jwt_secret.encode()), "alg": "HS256"}
    values = {
        "JWT_SECRET": jwt_secret,
        "JWT_KEYS": json.dumps([private_jwk, legacy_jwk], separators=(",", ":")),
        # This service-to-service JWKS contains the legacy symmetric key and is private.
        # Only GoTrue's filtered public JWKS endpoint may be exposed to clients. The
        # Realtime key verifies only here: GoTrue signs and publishes from JWT_KEYS.
        "JWT_JWKS": json.dumps(
            {"keys": [public_jwk, legacy_jwk, realtime_public_jwk]}, separators=(",", ":")
        ),
        "SUPABASE_PUBLISHABLE_KEY": _opaque_key("sb_publishable_"),
        "SUPABASE_SECRET_KEY": _opaque_key("sb_secret_"),
        "SUPABASE_SESSION_ENCRYPTION_KEY": Fernet.generate_key().decode("ascii"),
        "PUBLICATION_SIGNING_KEY": secrets.token_urlsafe(48),
        "POSTGRES_PASSWORD": secrets.token_hex(24),
        "DASHBOARD_PASSWORD": "a" + secrets.token_hex(24),
        "PG_META_CRYPTO_KEY": base64.b64encode(secrets.token_bytes(24)).decode("ascii"),
        **realtime,
    }
    issued_at = int(time.time())
    for name, role in (("ANON_KEY", "anon"), ("SERVICE_ROLE_KEY", "service_role")):
        claims = {
            "role": role, "iss": "supabase", "iat": issued_at,
            "exp": issued_at + 5 * 365 * 24 * 60 * 60,
        }
        values[name] = jwt.encode(claims, jwt_secret, algorithm="HS256")
        values[f"{name}_ASYMMETRIC"] = jwt.encode(
            claims, private_key, algorithm="ES256", headers={"kid": private_jwk["kid"]},
        )
    return values


def write_secret_file(path: Path) -> None:
    """Create a new owner-only dotenv file; never rotate existing installation keys."""
    values = generate_secrets()
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            for name, value in values.items():
                output.write(f"{name}='{value}'\n")
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def add_realtime_secrets(path: Path) -> None:
    """Add the Realtime names to an existing installation file; never replace them.

    The one ``JWT_JWKS=`` line gains the new public key; every other line stays as it is.
    The file is replaced atomically with owner-only permissions.
    """
    values = read_environment(path)
    if any(name in values for name in REALTIME_KEYS):
        raise FileExistsError("Realtime keys already exist")
    lines = path.read_text(encoding="utf-8").splitlines()
    positions = [index for index, line in enumerate(lines) if _JWKS_LINE.match(line)]
    if len(positions) != 1 or "${" in lines[positions[0]]:
        raise ConfigurationError("JWT_JWKS must be defined once with a literal value")
    try:
        jwks = json.loads(values["JWT_JWKS"])
        keys = jwks["keys"]
        if not isinstance(keys, list):
            raise ValueError
    except (KeyError, TypeError, ValueError):
        raise ConfigurationError("JWT_JWKS is not a JSON key set") from None
    realtime, public_jwk = realtime_secrets()
    jwks["keys"] = [*keys, public_jwk]
    lines[positions[0]] = "JWT_JWKS='" + json.dumps(jwks, separators=(",", ":")) + "'"
    lines.extend(f"{name}='{value}'" for name, value in realtime.items())
    temporary = path.with_name(path.name + ".realtime.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write("\n".join(lines) + "\n")
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--output", type=Path, help="new private dotenv file")
    target.add_argument(
        "--add-realtime", type=Path, metavar="ENV_FILE",
        help="existing private installation file that lacks the Realtime keys",
    )
    options = parser.parse_args()
    if options.add_realtime is not None:
        try:
            add_realtime_secrets(options.add_realtime)
        except FileExistsError:
            parser.exit(1, "Refusing to replace existing Realtime keys.\n")
        except ConfigurationError as error:
            parser.exit(1, f"{error}.\n")
        except OSError:
            parser.exit(1, "Could not update the private key file.\n")
        print("Added Realtime keys; no secret values were printed.")
        return
    try:
        write_secret_file(options.output)
    except FileExistsError:
        parser.exit(1, "Refusing to overwrite existing installation keys.\n")
    except OSError:
        parser.exit(1, "Could not create the private key file.\n")
    print("Created installation keys; no secret values were printed.")


if __name__ == "__main__":
    main()
