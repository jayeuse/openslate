"""Search input, original-code-point highlights and fail-closed current-source boundaries."""

import pytest
from sqlalchemy import event, select

from app.systems.manage.audit.models import AuditLog
from tests.comms.routes.message_support import send
from tests.comms.routes.search.test_comms_search_routes import message_ids, search
from tests.comms.routes.structure_support import ROOT

pytestmark = pytest.mark.integration


def test_search_uses_original_code_points_and_strict_filter_contract(search_case):
    case, org = search_case, search_case.world.first
    api = case.client(org.author, org.id)
    message = send(
        api, f"{ROOT}/conversations/{org.conversation}/messages", "😀 İ comet <b>COMET</b>"
    )
    with case.world.session(org) as db:
        before = set(db.scalars(select(AuditLog.id).where(AuditLog.org_id == org.id)))
    hits = search(api, q="comet")
    assert message_ids(hits) == [message["id"]]
    assert hits["items"][0]["excerpt"] == "😀 İ comet <b>COMET</b>"
    assert hits["items"][0]["matches"] == [{"start": 4, "end": 9}, {"start": 13, "end": 18}]
    assert search(api, q="")["items"][0]["matches"] == []
    assert search(api, q="comet", after="9999-12-31")["items"] == []
    for query in (
        {"limit": 0},
        {"limit": 101},
        {"offset": -1},
        {"offset": 9007199254740992},
        {"q": "x" * 4001},
        {"q": "\x00"},
        {"from": "not-a-uuid"},
        {"in": "bad"},
        {"has": "anything"},
        {"is": "deleted"},
        {"sort_by": "body"},
        {"on": "2026-02-30"},
        {"on": "2026-10-19T00:00:00Z"},
        {"after": "2026-10-20", "before": "2026-10-19"},
        {"after": "2026-10-19", "before": "2026-10-19"},
        {"org_id": str(case.world.second.id)},
    ):
        refused = api.get(ROOT + "/search", params={"q": "comet", **query})
        assert refused.status_code == 422, (query, refused.text)
    with case.world.session(org) as db:
        assert set(db.scalars(select(AuditLog.id).where(AuditLog.org_id == org.id))) == before
    assert (
        case.routes.anonymous_client(org.id)
        .get(ROOT + "/search", params={"q": "comet"})
        .status_code
        == 401
    )


def test_search_rechecks_captured_conversations_before_returning_hits_or_totals(search_case):
    case, org = search_case, search_case.world.first
    case.seed_search_visibility()
    reader = case.client(org.peer, org.id)
    changed = []

    def revoke_after_projection(_connection, _cursor, statement, _parameters, _context, _many):
        if changed or "comms_messages.body" not in statement or " AS excerpt" not in statement:
            return
        changed.append(True)
        case.routes.hide_other_conversation()

    event.listen(case.world.runtime, "after_cursor_execute", revoke_after_projection)
    try:
        response = reader.get(
            ROOT + "/search", params={"q": "kumquat", "limit": 1, "sort_by": "created_at"}
        )
    finally:
        event.remove(case.world.runtime, "after_cursor_execute", revoke_after_projection)
    assert changed == [True]
    assert response.status_code == 404
    assert set(response.json()) == {"detail"}
    assert "no-store" in response.headers["cache-control"]
    assert search(reader)["pagination"]["total"] == 1
