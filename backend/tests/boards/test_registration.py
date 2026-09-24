"""The complete Board API is mounted in an unambiguous order."""

from fastapi.routing import APIRoute

from app.main import app
from app.systems.boards.event_router import router as board_events_router
from app.systems.boards.personal_router import router as board_personal_router
from app.systems.boards.router import router as boards_router


def test_board_routes_and_purge_are_registered() -> None:
    mounted = {
        (path, method.upper())
        for path, operations in app.openapi()["paths"].items()
        for method in operations
    }
    assert {
        ("/api/boards", "GET"),
        ("/api/boards", "POST"),
        ("/api/boards/{board_id}", "GET"),
        ("/api/boards/{board_id}/grants", "GET"),
        ("/api/boards/{board_id}/widgets", "GET"),
        ("/api/boards/{board_id}/placements", "GET"),
        ("/api/boards/{board_id}/access-preview", "GET"),
        ("/api/boards/{board_id}/my-access", "GET"),
        ("/api/boards/{board_id}/activity", "GET"),
        ("/api/boards/{board_id}/configuration", "GET"),
        ("/api/boards/import", "POST"),
        ("/api/board-templates", "GET"),
        ("/api/boards/personal", "GET"),
        ("/api/boards/{board_id}/events", "GET"),
        ("/api/boards/{board_id}/events/occurrences", "GET"),
        ("/api/boards/{board_id}/files", "POST"),
        ("/api/boards/{board_id}/events/{event_id}/attachments", "GET"),
        ("/api/boards/{board_id}/events/{event_id}/record-links", "GET"),
        ("/api/boards/{board_id}/purge", "POST"),
    } <= mounted


def test_static_board_paths_precede_uuid_detail_paths() -> None:
    included = [
        route.original_router
        for route in app.router.routes
        if hasattr(route, "original_router")
    ]
    event_paths = [
        route.path for route in board_events_router.routes if isinstance(route, APIRoute)
    ]

    assert included.index(board_personal_router) < included.index(boards_router)
    assert event_paths.index("/boards/{board_id}/events/occurrences") < event_paths.index(
        "/boards/{board_id}/events/{event_id}"
    )
