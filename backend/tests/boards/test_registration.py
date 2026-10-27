"""Board routers are mounted in an unambiguous order; contracts/openapi.json owns the route set."""

from fastapi.routing import APIRoute

from app.main import app
from app.systems.boards.card_router import router as board_cards_router
from app.systems.boards.cross_board_occurrence_router import router as board_occurrences_router
from app.systems.boards.due_card_router import router as board_due_cards_router
from app.systems.boards.event_author_router import router as board_event_authors_router
from app.systems.boards.event_router import router as board_events_router
from app.systems.boards.router import router as boards_router


def test_static_board_paths_precede_uuid_detail_paths() -> None:
    included = [
        route.original_router for route in app.router.routes if hasattr(route, "original_router")
    ]
    event_paths = [
        route.path for route in board_events_router.routes if isinstance(route, APIRoute)
    ]

    assert included.index(board_event_authors_router) < included.index(board_events_router)
    assert included.index(board_occurrences_router) < included.index(boards_router)
    assert event_paths.index("/boards/{board_id}/events/occurrences") < event_paths.index(
        "/boards/{board_id}/events/{event_id}"
    )



def test_cards_due_precedes_the_board_card_and_board_detail_paths() -> None:
    included = [
        route.original_router for route in app.router.routes if hasattr(route, "original_router")
    ]

    assert included.index(board_due_cards_router) < included.index(board_cards_router)
    assert included.index(board_due_cards_router) < included.index(boards_router)
