"""Conversation binary routes receive the existing platform lease and byte/deadline bounds."""

from uuid6 import uuid7

from app.core.middleware.file_transfers import FileTransferPolicy, file_transfer_policy


def test_comms_binary_transfers_use_platform_bounds_without_broadening_json_paths():
    path = f"/api/comms/conversations/{uuid7()}/files/{uuid7()}/content"
    assert file_transfer_policy(path, "PUT") == FileTransferPolicy(10 * 1024 * 1024, 120)
    assert file_transfer_policy(path, "GET") == FileTransferPolicy(1024 * 1024, 120)
    for method, invalid in (
        ("POST", path),
        ("PUT", path + "/extra"),
        ("PUT", path.replace("/files/", "/messages/")),
    ):
        assert file_transfer_policy(invalid, method) is None


def test_confirmed_conversation_purge_uses_existing_storage_worker_admission_only_on_post():
    path = f"/api/comms/conversations/{uuid7()}/purge"
    assert file_transfer_policy(path, "POST") == FileTransferPolicy(1024 * 1024, 120)
    for method, invalid in (("GET", path), ("POST", path + "/preview"), ("POST", path + "/extra")):
        assert file_transfer_policy(invalid, method) is None
