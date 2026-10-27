"""Builders for Kanban tests: the routers, stages, cards and a readable Record source."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.card_activity_router import router as activity_router
from app.systems.boards.card_batch_router import router as batch_router
from app.systems.boards.card_router import router as card_router
from app.systems.boards.checklist_router import router as checklist_router
from app.systems.boards.kanban_models import BoardCard, BoardStage
from app.systems.boards.label_router import router as label_router
from app.systems.boards.models import Board
from app.systems.boards.stage_router import router as stage_router
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from tests.boards.support import client
from tests.rbac.support import make_group_access, organization

ROUTERS = (stage_router, label_router, batch_router, card_router, checklist_router,
           activity_router)


def kanban(db: Session, actor: User) -> TestClient:
    return client(db, actor, *ROUTERS)


def add_stage(db: Session, board: Board, name: str = "To do", position: int = 0,
              **values: Any) -> BoardStage:
    row = BoardStage(org_id=board.org_id, board_id=board.id, name=name, position=position,
                     **values)
    db.add(row)
    db.flush()
    return row


def add_objective(db: Session, board: Board, stage: BoardStage, title: str, rank: int,
                  **values: Any) -> BoardCard:
    row = BoardCard(org_id=board.org_id, board_id=board.id, stage_id=stage.id,
                    kind="objective", title=title, rank=rank, **values)
    db.add(row)
    db.flush()
    return row


def add_record_card(db: Session, board: Board, stage: BoardStage, record: Record,
                    rank: int) -> BoardCard:
    row = BoardCard(org_id=board.org_id, board_id=board.id, stage_id=stage.id, kind="record",
                    module_id=record.module_id, record_id=record.id, rank=rank)
    db.add(row)
    db.flush()
    return row


@dataclass
class Source:
    department: Department
    module: Module
    record: Record
    fields: dict[str, Field]


def record_source(db: Session, *readers: User, level: str = AccessLevel.READ) -> Source:
    """A module whose Record has a title, a status, two plain fields and three others.

    Field order: Notes (long text), Title (title field), Owner (text), Paid (boolean),
    Stage (select: the status), Quoted on (date), Amount (number), Region (text).
    """

    department = Department(org_id=organization(db).id,
                            department_name=f"Kanban source {uuid7().hex[-12:]}")
    db.add(department)
    db.flush()
    module = Module(org_id=department.org_id, department_id=department.id,
                    module_name="Quotes")
    db.add(module)
    db.flush()
    specs = (
        ("Notes", FieldType.LONG_TEXT, {}),
        ("Title", FieldType.TEXT, {}),
        ("Owner", FieldType.TEXT, {}),
        ("Paid", FieldType.BOOLEAN, {}),
        ("Stage", FieldType.SELECT, {"options": [{"id": "sent", "label": "Sent"}]}),
        ("Quoted on", FieldType.DATE, {}),
        ("Amount", FieldType.NUMBER, {}),
        ("Region", FieldType.TEXT, {}),
    )
    fields: dict[str, Field] = {}
    for position, (name, kind, config) in enumerate(specs):
        field = Field(org_id=module.org_id, module_id=module.id, name=name, type=kind,
                      position=position, required=False, config=config)
        db.add(field)
        db.flush()
        fields[name] = field
    module.title_field_id = fields["Title"].id
    values = {"Notes": "Private notes", "Title": "Harbor crane quote", "Owner": "Rosa",
              "Paid": True, "Stage": "sent", "Quoted on": "2026-10-01", "Amount": 1200,
              "Region": "North"}
    record = Record(org_id=module.org_id, module_id=module.id,
                    data={str(fields[name].id): value for name, value in values.items()})
    db.add(record)
    db.flush()
    if readers:
        make_group_access(db, readers, department, module, level=level)
    return Source(department, module, record, fields)
