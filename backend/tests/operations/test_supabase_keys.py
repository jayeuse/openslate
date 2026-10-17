"""Validate generated keys with the libraries used by independent consumers."""

import json
import os
from pathlib import Path

import jwt
import pytest
from cryptography.fernet import Fernet

from app.core.config.environment import read_environment
from operations.supabase_keys import add_realtime_secrets, generate_secrets, write_secret_file


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


def test_realtime_token_key_verifies_only_through_the_service_jwks() -> None:
    values = generate_secrets()
    private_jwk = json.loads(values["REALTIME_TOKEN_SIGNING_KEY"])
    service_keys = json.loads(values["JWT_JWKS"])["keys"]
    auth_signing_kids = {key.get("kid") for key in json.loads(values["JWT_KEYS"])}
    public = [key for key in service_keys if key.get("kid") == private_jwk["kid"]]
    assert len(public) == 1 and "d" not in public[0]
    # GoTrue signs and publishes only JWT_KEYS; the Realtime key must not be among them.
    assert private_jwk["kid"] not in auth_signing_kids
    token = jwt.encode(
        {"role": "authenticated"}, jwt.PyJWK(private_jwk).key, algorithm="ES256",
        headers={"kid": private_jwk["kid"]},
    )
    assert jwt.decode(token, jwt.PyJWK(public[0]).key, algorithms=["ES256"])["role"] == (
        "authenticated"
    )
    assert len(values["REALTIME_DB_ENC_KEY"].encode()) == 16
    assert len(values["REALTIME_SECRET_KEY_BASE"]) >= 64


def test_realtime_keys_join_an_existing_installation_once(tmp_path: Path, capsys) -> None:
    original = generate_secrets()
    del original["REALTIME_TOKEN_SIGNING_KEY"], original["REALTIME_SECRET_KEY_BASE"]
    del original["REALTIME_DB_ENC_KEY"]
    original["JWT_JWKS"] = json.dumps({"keys": json.loads(original["JWT_JWKS"])["keys"][:2]})
    path = tmp_path / ".env"
    path.write_text(
        "# kept comment\n" + "".join(f"{name}='{value}'\n" for name, value in original.items()),
        encoding="utf-8",
    )
    path.chmod(0o600)

    add_realtime_secrets(path)

    values = read_environment(path)
    assert path.read_text(encoding="utf-8").startswith("# kept comment\n")
    assert {name: values[name] for name in original if name != "JWT_JWKS"} == {
        name: value for name, value in original.items() if name != "JWT_JWKS"
    }
    keys = json.loads(values["JWT_JWKS"])["keys"]
    assert keys[:2] == json.loads(original["JWT_JWKS"])["keys"]
    assert keys[2]["kid"] == json.loads(values["REALTIME_TOKEN_SIGNING_KEY"])["kid"]
    if os.name != "nt":
        assert path.stat().st_mode & 0o777 == 0o600
    before = path.read_text(encoding="utf-8")
    with pytest.raises(FileExistsError):
        add_realtime_secrets(path)
    assert path.read_text(encoding="utf-8") == before
    assert not capsys.readouterr().out
