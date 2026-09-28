"""The complete Board API is mounted in an unambiguous order, without retired routes."""

from fastapi.routing import APIRoute

from app.main import app
from app.systems.boards.event_author_router import router as board_event_authors_router
from app.systems.boards.event_router import router as board_events_router
from app.systems.boards.portability_router import router as board_portability_router
from app.systems.boards.router import router as boards_router


def _mounted() -> set[tuple[str, str]]:
    return {
        (path, method.upper())
        for path, operations in app.openapi()["paths"].items()
        for method in operations
    }


def test_board_routes_and_purge_are_registered() -> None:
    assert {
        ("/api/boards", "GET"),
        ("/api/boards", "POST"),
        ("/api/boards/{board_id}", "GET"),
        ("/api/boards/{board_id}/groups", "GET"),
        ("/api/boards/{board_id}/groups", "PUT"),
        ("/api/boards/{board_id}/widgets", "GET"),
        ("/api/boards/{board_id}/access-preview", "GET"),
        ("/api/boards/{board_id}/my-access", "GET"),
        ("/api/boards/{board_id}/activity", "GET"),
        ("/api/boards/{board_id}/configuration", "GET"),
        ("/api/boards/import", "POST"),
        ("/api/boards/{board_id}/posts", "GET"),
        ("/api/boards/{board_id}/posts/{post_id}/revisions", "GET"),
        ("/api/boards/{board_id}/posts/{post_id}/revisions/{revision_id}", "GET"),
        ("/api/boards/{board_id}/post-authors", "GET"),
        ("/api/boards/{board_id}/events", "GET"),
        ("/api/boards/{board_id}/events/occurrences", "GET"),
        ("/api/boards/{board_id}/files", "POST"),
        ("/api/boards/{board_id}/events/{event_id}/attachments", "GET"),
        ("/api/boards/{board_id}/events/{event_id}/record-links", "GET"),
        ("/api/boards/{board_id}/purge", "POST"),
    } <= _mounted()


def test_retired_board_routes_are_gone() -> None:
    paths = {path for path, _ in _mounted()}
    for retired in (
        "/api/boards/{board_id}/grants",
        "/api/boards/{board_id}/placements",
        "/api/boards/{board_id}/announcements",
        "/api/boards/{board_id}/announcement-authors",
        "/api/boards/{board_id}/reminders",
        "/api/boards/{board_id}/content-audience-targets",
        "/api/boards/personal",
        "/api/board-templates",
    ):
        assert retired not in paths


def test_static_board_paths_precede_uuid_detail_paths() -> None:
    included = [
        route.original_router
        for route in app.router.routes
        if hasattr(route, "original_router")
    ]
    event_paths = [
        route.path for route in board_events_router.routes if isinstance(route, APIRoute)
    ]

    assert included.index(board_portability_router) < included.index(boards_router)
    assert included.index(board_event_authors_router) < included.index(board_events_router)
    assert event_paths.index("/boards/{board_id}/events/occurrences") < event_paths.index(
        "/boards/{board_id}/events/{event_id}"
    )
