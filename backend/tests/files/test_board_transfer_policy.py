"""Board file bytes use the same bounded transfer admission as generic files."""

from uuid import uuid4

import pytest

from app.core.middleware.file_transfers import FileTransferPolicy, file_transfer_policy
from app.main import create_app

MIB = 1024 * 1024
BOARD, FILE, ITEM = "019c0000-0000-7000-8000-00000000000b", str(uuid4()), str(uuid4())


def test_board_file_upload_and_contextual_download_receive_transfer_leases() -> None:
    board, file, event, notice, card = (uuid4() for _ in range(5))
    upload = file_transfer_policy(f"/api/boards/{board}/files/{file}/content", "PUT")
    event_download = file_transfer_policy(
        f"/api/boards/{board}/events/{event}/attachments/{file}/content", "GET"
    )
    notice_download = file_transfer_policy(
        f"/api/boards/{board}/posts/{notice}/attachments/{file}/content", "GET"
    )
    card_download = file_transfer_policy(
        f"/api/boards/{board}/cards/{card}/attachments/{file}/content", "GET"
    )
    reconcile = file_transfer_policy(f"/api/boards/{board}/files/{file}/reconcile", "POST")
    purge = file_transfer_policy(f"/api/boards/{board}/files/{file}/purge", "POST")
    assert upload is not None and upload.request_bytes == 10 * 1024 * 1024
    assert event_download is not None and event_download.deadline_seconds == 120
    assert notice_download is not None and notice_download.deadline_seconds == 120
    assert card_download is not None and card_download.deadline_seconds == 120
    assert reconcile is not None and purge is not None
    assert file_transfer_policy(f"/api/boards/{board}/files/{file}/content", "GET") is None


def test_board_file_and_post_routes_are_mounted() -> None:
    routes = create_app().openapi()["paths"]
    assert "post" in routes["/api/boards/{board_id}/files"]
    assert "get" in routes["/api/boards/{board_id}/posts/{post_id}/attachments"]
    assert "post" in routes["/api/boards/{board_id}/posts/{post_id}/publish"]


@pytest.mark.parametrize(
    ("path", "method", "policy"),
    [
        pytest.param("/api/workspace/logo", "GET", FileTransferPolicy(MIB, 120), id="logo"),
        pytest.param(
            f"/api/files/{FILE}/content", "PUT", FileTransferPolicy(10 * MIB, 120), id="upload"
        ),
        pytest.param(
            f"/api/files/{FILE}/content", "GET", FileTransferPolicy(MIB, 120), id="download"
        ),
        pytest.param(
            f"/api/files/{FILE}/reconcile", "POST", FileTransferPolicy(MIB, 120), id="reconcile"
        ),
        pytest.param(f"/api/files/{FILE}/purge", "POST", FileTransferPolicy(MIB, 120), id="purge"),
        pytest.param(
            f"/api/boards/{BOARD}/posts/{ITEM}/attachments/{FILE}/content",
            "GET",
            FileTransferPolicy(MIB, 120),
            id="board-attachment",
        ),
        pytest.param(f"/api/files/{FILE}/reconcile", "GET", None, id="reconcile-read"),
        pytest.param(f"/api/files/{FILE}/content", "POST", None, id="content-post"),
    ],
)
def test_each_known_file_request_gets_its_body_limit_and_deadline(
    path: str, method: str, policy: FileTransferPolicy | None
) -> None:
    """Uploads take the 10 MiB file limit; every other file request keeps 1 MiB; all get 120 s."""

    assert file_transfer_policy(path, method) == policy
