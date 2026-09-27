"""Writer-quiescence admission for the guarded reset utility."""

import socket

import pytest

from operations.reset_models import ResetError
from operations.reset_storage import require_api_stopped


def test_api_writer_admission_is_cross_platform_and_fail_closed(monkeypatch) -> None:
    def refused(*_args, **_kwargs):
        raise ConnectionRefusedError

    monkeypatch.setattr(socket, "create_connection", refused)
    assert require_api_stopped("127.0.0.1", "8000") is None
    assert require_api_stopped("::1", "8000") is None

    class Connected:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

    monkeypatch.setattr(socket, "create_connection", lambda *_args, **_kwargs: Connected())
    with pytest.raises(ResetError, match="must be stopped"):
        require_api_stopped("::", "8000")
    with pytest.raises(ResetError, match="valid"):
        require_api_stopped("127.0.0.1", "invalid")
    with pytest.raises(ResetError, match="not supported"):
        require_api_stopped("192.168.1.10", "8000")
