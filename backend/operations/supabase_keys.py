"""Generate installation secrets without printing or invoking a shell."""

import argparse
import base64
import hashlib
import json
import os
import secrets
import time
from pathlib import Path
from uuid import uuid4

import jwt
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.asymmetric import ec


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _opaque_key(prefix: str) -> str:
    # Match the pinned self-hosted gateway key format, without shell dependencies.
    intermediate = prefix + secrets.token_urlsafe(17)[:22]
    digest = hashlib.sha256(f"supabase-self-hosted|{intermediate}".encode()).digest()
    return intermediate + "_" + _base64url(digest)[:8]


def generate_secrets() -> dict[str, str]:
    """Return fresh self-hosted provider and application session keys."""
    private_key = ec.generate_private_key(ec.SECP256R1())
    private_jwk = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(private_key))
    private_jwk.update(
        kid=str(uuid4()), use="sig", key_ops=["sign", "verify"], alg="ES256", ext=True,
    )
    public_jwk = {key: value for key, value in private_jwk.items() if key != "d"}
    public_jwk["key_ops"] = ["verify"]
    jwt_secret = secrets.token_urlsafe(48)
    legacy_jwk = {"kty": "oct", "k": _base64url(jwt_secret.encode()), "alg": "HS256"}
    values = {
        "JWT_SECRET": jwt_secret,
        "JWT_KEYS": json.dumps([private_jwk, legacy_jwk], separators=(",", ":")),
        # This service-to-service JWKS contains the legacy symmetric key and is private.
        # Only GoTrue's filtered public JWKS endpoint may be exposed to clients.
        "JWT_JWKS": json.dumps({"keys": [public_jwk, legacy_jwk]}, separators=(",", ":")),
        "SUPABASE_PUBLISHABLE_KEY": _opaque_key("sb_publishable_"),
        "SUPABASE_SECRET_KEY": _opaque_key("sb_secret_"),
        "SUPABASE_SESSION_ENCRYPTION_KEY": Fernet.generate_key().decode("ascii"),
        "PUBLICATION_SIGNING_KEY": secrets.token_urlsafe(48),
        "POSTGRES_PASSWORD": secrets.token_hex(24),
        "DASHBOARD_PASSWORD": "a" + secrets.token_hex(24),
        "PG_META_CRYPTO_KEY": base64.b64encode(secrets.token_bytes(24)).decode("ascii"),
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="new private dotenv file")
    options = parser.parse_args()
    try:
        write_secret_file(options.output)
    except FileExistsError:
        parser.exit(1, "Refusing to overwrite existing installation keys.\n")
    except OSError:
        parser.exit(1, "Could not create the private key file.\n")
    print("Created installation keys; no secret values were printed.")


if __name__ == "__main__":
    main()
