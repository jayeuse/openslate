"""Validate generated keys with the libraries used by independent consumers."""

import json
import os
from pathlib import Path

import jwt
import pytest
from cryptography.fernet import Fernet

from app.core.config.environment import read_environment
from operations.supabase_keys import generate_secrets, write_secret_file


def test_generated_keys_support_provider_signing_and_session_encryption() -> None:
    values = generate_secrets()
    assert {"JWT_KEYS", "JWT_JWKS", "ANON_KEY", "SERVICE_ROLE_KEY"} <= values.keys()
    private_keys = json.loads(values["JWT_KEYS"])
    public_keys = json.loads(values["JWT_JWKS"])["keys"]
    signing_key = jwt.PyJWK(private_keys[0]).key
    verification_key = jwt.PyJWK(public_keys[0]).key
    signed = jwt.encode({"sub": "provider-user"}, signing_key, algorithm="ES256")
    assert jwt.decode(signed, verification_key, algorithms=["ES256"])["sub"] == "provider-user"
    assert "d" not in public_keys[0]
    for name, role in (("ANON_KEY", "anon"), ("SERVICE_ROLE_KEY", "service_role")):
        assert jwt.decode(
            values[name], values["JWT_SECRET"], algorithms=["HS256"], issuer="supabase",
        )["role"] == role
        assert jwt.decode(
            values[f"{name}_ASYMMETRIC"], verification_key,
            algorithms=["ES256"], issuer="supabase",
        )["role"] == role
    cipher = Fernet(values["SUPABASE_SESSION_ENCRYPTION_KEY"])
    assert cipher.decrypt(cipher.encrypt(b"provider-refresh")) == b"provider-refresh"


def test_each_installation_gets_independent_keys(capsys) -> None:
    first, second = generate_secrets(), generate_secrets()
    assert first
    assert first.keys() == second.keys()
    assert all(first[key] != second[key] for key in first)
    assert not capsys.readouterr().out


def test_secret_file_is_private_and_round_trips_without_stdout(tmp_path: Path, capsys) -> None:
    path = tmp_path / ".env"
    write_secret_file(path)
    assert path.is_file()
    if os.name != "nt":
        assert path.stat().st_mode & 0o777 == 0o600
    values = read_environment(path)
    assert "JWT_KEYS" in values
    jwt.PyJWK(json.loads(values["JWT_KEYS"])[0])
    assert not capsys.readouterr().out


def test_key_generation_cannot_overwrite_existing_installation(tmp_path: Path) -> None:
    path = tmp_path / ".env"
    path.write_text("existing-installation", encoding="utf-8")
    with pytest.raises(FileExistsError):
        write_secret_file(path)
    assert path.read_text(encoding="utf-8") == "existing-installation"
