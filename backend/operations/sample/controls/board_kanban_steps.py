"""The four Kanban control steps; ``board_kanban`` plans them and owns the run helper."""

from __future__ import annotations

from datetime import date

from app.systems.boards.calendar_source_router import CalendarSourceResponse
from app.systems.boards.due_card_router import DueCardListResponse
from app.systems.boards.event_schemas import CrossBoardOccurrenceListResponse
from app.systems.boards.kanban_schemas import (
    CardActivityListResponse,
    CardBatchDatesResponse,
    CardDetail,
    CardListResponse,
    ChecklistItemResponse,
    ChecklistItems,
    LabelListResponse,
    LabelResponse,
    StageItems,
    StageListResponse,
    StageResponse,
)
from app.systems.boards.record_link_router import RecordLinkResponse
from app.systems.platform.files.schemas import FileResponse
from app.systems.sandbox.lifecycle.schemas import LifecyclePurgePreviewResponse
from operations.sample.controls.board_kanban import _Kanban
from operations.sample.dummy_files import dummy_file
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _result,
)
from operations.sample.population.board_files import UPLOAD_HEADERS, download_issue


def _create(run: _Kanban) -> None:
    stage_ids: list[str] = []
    for number, (name, color) in enumerate(run.pairs("stages"), start=1):
        body = {"name": name, "color": color}
        row: StageResponse = run.call("POST", f"{run.base}/stages", f"create_stage_{number}",
                                      StageResponse, json_body=body)  # fmt: skip
        run.check(row.name == name and row.archived_at is None, f"create_stage_{number}")
        stage_ids.append(run.keep(f"stage:{number}", row.id))
    for number, (name, color) in enumerate(run.pairs("labels"), start=1):
        body = {"name": name, "color": color}
        label: LabelResponse = run.call("POST", f"{run.base}/labels", f"create_label_{number}",
                                        LabelResponse, json_body=body)  # fmt: skip
        run.check(label.name == name, f"create_label_{number}")
        run.keep(f"label:{number}", label.id)
    assignee = run.mapped("user", run.action.actor_key)
    objective: CardDetail = run.call(
        "POST", f"{run.base}/cards", "create_objective_card", CardDetail,
        json_body={"kind": "objective", "stage_id": stage_ids[0], "title": run.text("title"),
                   "description": run.values.get("description"), "assignee_id": assignee,
                   "due_on": run.text("due_on")},
    )  # fmt: skip
    run.check(objective.kind == "objective" and str(objective.assignee_id) == assignee
              and objective.due_on == date.fromisoformat(run.text("due_on")),
              "create_objective_card")  # fmt: skip
    run.keep("card:objective", objective.id)
    record_id = run.mapped("record", run.text("record_key"))
    record: CardDetail = run.call(
        "POST", f"{run.base}/cards", "create_record_card", CardDetail,
        json_body={"kind": "record", "stage_id": stage_ids[0], "record_id": record_id},
    )
    summary = record.record
    linked = str(getattr(summary, "record_id", ""))
    run.check(summary is not None and not summary.locked and linked == record_id,
              "create_record_card")  # fmt: skip
    run.keep("card:record", record.id)
    texts = run.values.get("checklist")
    if not isinstance(texts, list) or len(texts) != 2:
        raise SamplePhaseActionError("Planned Kanban checklist is invalid", step="add_checklist")
    for number, text in enumerate(texts, start=1):
        item: ChecklistItemResponse = run.call(
            "POST", f"{run.base}/cards/{objective.id}/checklist", f"add_checklist_{number}",
            ChecklistItemResponse, json_body={"text": text},
        )  # fmt: skip
        run.check(item.text == text and not item.done, f"add_checklist_{number}")
        run.keep(f"checklist:{number}", item.id)
    link: RecordLinkResponse = run.call(
        "POST", f"{run.base}/cards/{objective.id}/record-links", "link_card_record",
        RecordLinkResponse, json_body={"record_id": record_id, **run.content_revisions()},
    )  # fmt: skip
    run.check(str(link.record_id) == record_id and link.available, "link_card_record")
    run.keep("link", link.id)
    filename = run.text("filename")
    file: FileResponse = run.call(
        "POST", f"{run.base}/files", "reserve_card_file", FileResponse,
        json_body={"filename": filename, "expected_size": len(dummy_file(filename))},
    )
    run.check(file.state == "awaiting_upload", "reserve_card_file")
    run.keep("file", file.id)
    source = {"module_id": run.mapped("modules", run.text("module_key")),
              "date_field_id": run.mapped("fields", run.text("field_key"))}  # fmt: skip
    for name, path in (("board_source", f"{run.base}/calendar-sources"),
                       ("my_source", "/api/me/calendar-sources")):  # fmt: skip
        added: CalendarSourceResponse = run.call(
            "POST", path, f"add_{name}", CalendarSourceResponse, json_body=source
        )
        run.check(str(added.date_field_id) == source["date_field_id"], f"add_{name}")
        run.keep(name, added.id)
    stages = run.read(f"{run.base}/stages", "list_stages", StageListResponse)
    labels = run.read(f"{run.base}/labels", "list_labels", LabelListResponse)
    cards = run.read(f"{run.base}/cards", "list_cards", CardListResponse)
    run.check([str(row.id) for row in stages.items] == stage_ids and len(labels.items) == 2
              and {str(row.id) for row in cards.items}
              == {run.own("card:objective"), run.own("card:record")}, "list_kanban")  # fmt: skip
    run.check(len(run.card("card:objective").checklist_items) == 2, "read_card:objective")
    board_sources, my_sources = run.sources("list_sources")
    run.check(run.own("board_source") in board_sources and run.own("my_source") in my_sources,
              "list_sources")  # fmt: skip


def _update(run: _Kanban) -> None:
    first, second = run.own("stage:1"), run.own("stage:2")
    label_one, label_two = run.own("label:1"), run.own("label:2")
    objective_id, record_id = run.own("card:objective"), run.own("card:record")
    file_id, filename = run.own("file"), run.text("filename")
    content = dummy_file(filename)
    uploaded: FileResponse = run.call(
        "PUT", f"{run.base}/files/{file_id}/content", "upload_card_file", FileResponse,
        headers=UPLOAD_HEADERS, content=content,
    )
    run.check(uploaded.state == "ready" and uploaded.actual_size == len(content),
              "upload_card_file")  # fmt: skip
    stages = {str(row.id): row for row in run.read(f"{run.base}/stages", "read_stages",
                                                   StageListResponse).items}  # fmt: skip
    patched: StageResponse = run.call(
        "PATCH", f"{run.base}/stages/{first}", "patch_stage", StageResponse,
        json_body={"revision": stages[first].revision, "wip_limit": 5},
    )
    run.check(patched.wip_limit == 5, "patch_stage")
    order: StageItems = run.call("PUT", f"{run.base}/stages/order", "order_stages", StageItems,
                                 json_body={"stage_ids": [second, first]})  # fmt: skip
    run.check([str(row.id) for row in order.items] == [second, first], "order_stages")
    labels = {str(row.id): row for row in run.read(f"{run.base}/labels", "read_labels",
                                                   LabelListResponse).items}  # fmt: skip
    renamed = f"{labels[label_one].name} (follow-up)"[:40]
    label: LabelResponse = run.call(
        "PATCH", f"{run.base}/labels/{label_one}", "patch_label", LabelResponse,
        json_body={"revision": labels[label_one].revision, "name": renamed},
    )
    run.check(label.name == renamed, "patch_label")
    moved: CardDetail = run.call(
        "PATCH", f"{run.base}/cards/{objective_id}", "move_card", CardDetail,
        json_body={"revision": run.card("card:objective").revision, "stage_id": second,
                   "position": 0, "label_ids": [label_one, label_two]},
    )  # fmt: skip
    applied = {str(item) for item in moved.label_ids}
    run.check(str(moved.stage_id) == second and applied == {label_one, label_two}, "move_card")
    items = {str(row.id): row for row in moved.checklist_items}
    one, two = run.own("checklist:1"), run.own("checklist:2")
    ticked: ChecklistItemResponse = run.call(
        "PATCH", f"{run.base}/checklist/{one}", "tick_checklist", ChecklistItemResponse,
        json_body={"revision": items[one].revision, "done": True},
    )
    run.check(ticked.done, "tick_checklist")
    ordered: ChecklistItems = run.call(
        "PUT", f"{run.base}/cards/{objective_id}/checklist/order", "order_checklist",
        ChecklistItems, json_body={"item_ids": [two, one]},
    )
    run.check([str(row.id) for row in ordered.items] == [two, one], "order_checklist")
    attached: FileResponse = run.call(
        "POST", f"{run.base}/cards/{objective_id}/attachments", "attach_card_file", FileResponse,
        json_body={"file_id": file_id, **run.content_revisions()},
    )
    run.check(str(attached.id) == file_id and attached.state == "ready", "attach_card_file")
    run.check(file_id in run.listed("attachments", "list_card_files"), "list_card_files")
    download = run.call("GET", f"{run.base}/cards/{objective_id}/attachments/{file_id}/content",
                        "download_card_file", None)  # fmt: skip
    run.check(download_issue(download, filename) is None, "download_card_file")
    run.check(run.own("link") in run.listed("record-links", "list_card_links"), "list_card_links")
    start_on, due_on = run.text("start_on"), run.text("batch_due_on")
    dated: CardBatchDatesResponse = run.call(
        "POST", f"{run.base}/cards/batch-dates", "batch_card_dates", CardBatchDatesResponse,
        json_body={"items": [{"card_id": run.own(name), "revision": run.card(name).revision,
                              "start_on": start_on, "due_on": due_on}
                             for name in ("card:objective", "card:record")]},
    )  # fmt: skip
    run.check([row.status for row in dated.results] == ["updated", "updated"], "batch_card_dates")
    archived: CardDetail = run.call(
        "POST", f"{run.base}/cards/{record_id}/archive", "archive_card", CardDetail,
        json_body={"revision": run.card("card:record").revision},
    )
    listed = run.read(f"{run.base}/cards", "list_archived_cards", CardListResponse,
                      archived="true")  # fmt: skip
    run.check(archived.archived_at is not None
              and record_id in {str(row.id) for row in listed.items}, "archive_card")  # fmt: skip
    restored: CardDetail = run.call(
        "POST", f"{run.base}/cards/{record_id}/restore", "restore_card", CardDetail,
        json_body={"revision": archived.revision},
    )
    run.check(restored.archived_at is None, "restore_card")
    current = run.read(f"{run.base}/stages", "read_stages_again", StageListResponse).items
    revision = next(row.revision for row in current if str(row.id) == second)
    stage: StageResponse = run.call(
        "POST", f"{run.base}/stages/{second}/archive", "archive_stage", StageResponse,
        json_body={"revision": revision, "cards": "move", "target_stage_id": first},
    )
    detail = run.card("card:objective")
    run.check(stage.archived_at is not None and str(detail.stage_id) == first
              and detail.checklist.done == 1
              and detail.due_on == date.fromisoformat(due_on), "archive_stage")  # fmt: skip
    activity = run.read(f"{run.base}/cards/{objective_id}/activity", "read_card_activity",
                        CardActivityListResponse)  # fmt: skip
    run.check(bool(activity.items), "read_card_activity")
    window = {"window_start": run.text("window_start"), "window_end": run.text("window_end")}
    occurrences = run.read("/api/boards/occurrences", "read_occurrences",
                           CrossBoardOccurrenceListResponse, board_id=[run.board_id],
                           **window)  # fmt: skip
    event_id = run.mapped("control_events", run.text("event_key"))
    run.check(any(row.event_id == event_id for row in occurrences.items)
              and [str(row.board_id) for row in occurrences.boards] == [run.board_id]
              and occurrences.boards[0].status == "ok", "read_occurrences")  # fmt: skip
    due = run.read("/api/boards/cards/due", "read_due_cards", DueCardListResponse,
                   **{"from": window["window_start"], "to": window["window_end"]})  # fmt: skip
    run.check(objective_id in {str(row.id) for row in due.items}, "read_due_cards")


def _remove(run: _Kanban) -> None:
    objective_id = run.own("card:objective")
    detail = run.card("card:objective")
    two = run.own("checklist:2")
    revision = next(row.revision for row in detail.checklist_items if str(row.id) == two)
    run.call("DELETE", f"{run.base}/checklist/{two}", "delete_checklist_item", None,
             json_body={"revision": revision})  # fmt: skip
    labels = run.read(f"{run.base}/labels", "read_labels", LabelListResponse).items
    label_two = run.own("label:2")
    revision = next(row.revision for row in labels if str(row.id) == label_two)
    run.call("DELETE", f"{run.base}/labels/{label_two}", "delete_label", None,
             json_body={"revision": revision})  # fmt: skip
    file_id, link_id = run.own("file"), run.own("link")
    run.call("DELETE", f"{run.base}/cards/{objective_id}/attachments/{file_id}",
             "detach_card_file", None, json_body=run.content_revisions())  # fmt: skip
    run.call("DELETE", f"{run.base}/cards/{objective_id}/record-links/{link_id}",
             "unlink_card_record", None, json_body=run.content_revisions())  # fmt: skip
    run.call("DELETE", f"{run.base}/calendar-sources/{run.own('board_source')}",
             "remove_board_source", None)  # fmt: skip
    run.call("DELETE", f"/api/me/calendar-sources/{run.own('my_source')}", "remove_my_source",
             None)  # fmt: skip
    detail = run.card("card:objective")
    run.check([str(row.id) for row in detail.checklist_items] == [run.own("checklist:1")]
              and [str(item) for item in detail.label_ids] == [run.own("label:1")],
              "read_card:objective")  # fmt: skip
    files, links = run.listed("attachments", "list_files"), run.listed("record-links", "list_links")
    run.check(not files and not links, "list_card_content")
    board_sources, my_sources = run.sources("list_sources")
    run.check(run.own("board_source") not in board_sources
              and run.own("my_source") not in my_sources, "list_sources")  # fmt: skip


def _purge_file(run: _Kanban) -> None:
    file_id, filename = run.own("file"), run.text("filename")
    base = f"{run.base}/files/{file_id}"
    archived: FileResponse = run.call("POST", f"{base}/archive", "archive_card_file", FileResponse)
    run.check(str(archived.id) == file_id, "archive_card_file")
    preview: LifecyclePurgePreviewResponse = run.call(
        "POST", f"{base}/purge/preview", "preview_card_file_purge", LifecyclePurgePreviewResponse
    )
    run.check(str(preview.impact.target_id) == file_id and not preview.impact.blockers
              and preview.confirmation_name == filename, "preview_card_file_purge")  # fmt: skip
    purged: FileResponse = run.call(
        "POST", f"{base}/purge", "purge_card_file", FileResponse,
        json_body={"token": preview.token, "confirmation_name": preview.confirmation_name,
                   "password": run.context.admin_password},
    )  # fmt: skip
    run.check(purged.state == "purged", "purge_card_file")


_STEPS = {"kanban_create": _create, "kanban_update": _update, "kanban_remove": _remove,
          "kanban_file_purge": _purge_file}  # fmt: skip


def execute_kanban_action(
    action: PhaseAction, context: PhaseExecutionContext, *, on_substep: PhaseSubstep | None
) -> dict[str, object]:
    operation = str(action.values.get("operation"))
    if operation not in _STEPS:
        raise SamplePhaseActionError("Unsupported Kanban control action", step=action.key)
    run = _Kanban(action, context, on_substep)
    _STEPS[operation](run)
    return _result(action, context, run.evidence, run.mappings,
                   extra={"operation": operation, "completed": True})  # fmt: skip

