import pytest

from tests.conftest import _guard_integration_database


def test_alternate_test_port_requires_explicit_disposable_tuple(monkeypatch):
    url = "postgresql+psycopg://test:test@127.0.0.1:55322/postgres"
    monkeypatch.delenv("E2E_ALLOW_MUTATIONS", raising=False)
    monkeypatch.delenv("OPENSLATE_FULLSTACK_RUN_ID", raising=False)
    with pytest.raises(RuntimeError):
        _guard_integration_database(url)
    monkeypatch.setenv("E2E_ALLOW_MUTATIONS", "true")
    monkeypatch.setenv("OPENSLATE_FULLSTACK_RUN_ID", "a" * 32)
    _guard_integration_database(url)
    for unsafe in (
        url.replace("127.0.0.1", "localhost"),
        url.replace("127.0.0.1", "production.example"),
        url.replace("55322", "55323"),
        url.replace("/postgres", "/production"),
    ):
        with pytest.raises(RuntimeError):
            _guard_integration_database(unsafe)
