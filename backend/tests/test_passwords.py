from app.core.security import hash_password, verify_password


def test_hash_password_uses_argon2_and_verifies() -> None:
    digest = hash_password("a sufficiently long password")

    assert digest.startswith("$argon2")
    assert verify_password("a sufficiently long password", digest)


def test_verify_password_rejects_wrong_password() -> None:
    digest = hash_password("a sufficiently long password")

    assert not verify_password("the wrong password", digest)
