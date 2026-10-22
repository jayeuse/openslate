"""A Harbor-sized organization for Comms access results and latency (sample-pack shape).

Six departments with three modules each, six five-person teams (team group rows as in
the Harbor pack), an operations group of team leads, an audit group, six guests, four
pending and two disabled people, the hands-on accounts, department and project Boards,
22 conversations (6 department channels, 3 organization channels, 13 direct or group
messages) and two D45 grants. Rows go through the caller's session; the caller commits
or rolls back.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import Group, GroupAccess, GroupMember
from app.systems.access.users.models import User
from app.systems.boards.models import Board, BoardGroup
from app.systems.comms.conversations.models import (
    CommsCategory,
    CommsChannelAccess,
    CommsConversation,
    CommsMember,
)
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
from tests.conftest import create_member

FUTURE = datetime(2100, 1, 1, tzinfo=UTC)
# Department-row level of each team group, as in the Harbor pack's GROUP_ACCESS.
TEAM_LEVELS = ("manage", "manage", "write", "write", "write", "write")


@dataclass
class HarborScale:
    admin: User
    teams: list[list[User]] = field(default_factory=list)
    guests: list[User] = field(default_factory=list)
    inactive: list[User] = field(default_factory=list)
    accounts: dict[str, User] = field(default_factory=dict)
    conversations: dict[str, UUID] = field(default_factory=dict)
    groups: dict[str, Group] = field(default_factory=dict)
    departments: list[Department] = field(default_factory=list)

    @property
    def people(self) -> list[User]:
        return [
            *(person for team in self.teams for person in team), *self.guests,
            *self.inactive, *self.accounts.values(),
        ]

    def channel_ids(self) -> list[UUID]:
        return [identity for name, identity in self.conversations.items() if name[0] in "KO"]


def build_harbor_scale(db: Session, org_id: UUID, admin: User, peer: User) -> HarborScale:
    organization = db.get(WorkspaceProfile, org_id)
    assert organization is not None

    def person(name: str, role: str = "member", **values) -> User:
        if role == "guest":
            values = {"sponsor_user_id": admin.id, "expires_at": FUTURE, **values}
        user, _ = create_member(
            db, organization, role=role, display_name=name, supabase_user_id=uuid7(), **values,
        )
        return user

    def group(name: str, members: list[User]) -> Group:
        row = Group(org_id=org_id, name=f"{name} {uuid7().hex}")
        db.add(row)
        db.flush()
        db.add_all(GroupMember(org_id=org_id, group_id=row.id, user_id=user.id) for user in members)
        world.groups[name] = row
        return row

    def access(row: Group, department: Department, level: str, module: Module | None = None):
        db.add(GroupAccess(
            org_id=org_id, group_id=row.id, department_id=department.id,
            module_id=module.id if module else None, level=level,
        ))

    def conversation(name: str, *, kind="channel", scope="members", department=None,
                     category=None, members=()) -> CommsConversation:
        row = CommsConversation(
            org_id=org_id, kind=kind, scope=scope, name=f"Harbor {name}",
            department_id=department.id if department else None,
            category_id=category.id if category else None, created_by=admin.id,
        )
        db.add(row)
        db.flush()
        db.add_all(CommsMember(
            org_id=org_id, conversation_id=row.id, user_id=user.id, role="member",
        ) for user in members)
        world.conversations[name] = row.id
        return row

    world = HarborScale(admin=admin, accounts={"admin": admin, "peer": peer})
    departments = [Department(org_id=org_id, department_name=f"Harbor {n}") for n in range(6)]
    db.add_all(departments)
    db.flush()
    world.departments = departments
    modules = [[Module(org_id=org_id, department_id=d.id, module_name=f"Harbor {d.department_name}"
                       f" {n}") for n in range(3)] for d in departments]
    db.add_all(module for row in modules for module in row)
    db.flush()
    world.teams = [[person(f"Team {t} person {p}") for p in range(5)] for t in range(6)]
    for index, team in enumerate(world.teams):
        own = group(f"Team {index}", team)
        access(own, departments[index], TEAM_LEVELS[index])
        access(own, departments[(index + 1) % 6], "read", modules[(index + 1) % 6][0])
    operations = group("Operations", [team[0] for team in world.teams])
    audit = group("Audit", world.teams[0][3:5])
    world.guests = [person(f"Guest {n}", "guest") for n in range(6)]
    guest_readers = group("Guest readers", world.guests)
    for department in departments:
        access(operations, department, "manage")
        access(guest_readers, department, "manage")
    access(audit, departments[5], "read")
    access(audit, departments[4], "read")
    world.inactive = [
        *(person(f"Pending {n}", status="pending") for n in range(4)),
        *(person(f"Disabled {n}", status="disabled") for n in range(2)),
    ]
    accounts = {
        "writer": person("ho-writer"), "manager": person("ho-manager"),
        "noaccess": person("ho-noaccess"), "reader": person("ho-reader"),
        "guest": person("ho-guest", "guest"),
    }
    world.accounts.update(accounts)
    writer = group("Writer", [accounts["writer"]])
    access(writer, departments[0], "write", modules[0][0])
    access(writer, departments[1], "read")
    access(group("Manager", [accounts["manager"]]), departments[2], "manage")
    access(group("Reader", [accounts["reader"]]), departments[4], "read")
    access(group("Guest", [accounts["guest"]]), departments[3], "read")
    boards = [Board(org_id=org_id, scope="department", name=f"Board {n}", department_id=d.id)
              for n, d in enumerate(departments)]
    project = Board(org_id=org_id, scope="project", name="Harbor project")
    db.add_all([*boards, project])
    db.flush()
    db.add(BoardGroup(org_id=org_id, board_id=project.id, group_id=operations.id, level="read"))
    category = CommsCategory(org_id=org_id, name="Harbor", position=1,
                             department_id=departments[0].id)
    db.add(category)
    db.flush()
    for n, department in enumerate(departments):
        conversation(f"K{n}", scope="department", department=department,
                     category=category if n == 0 else None)
    for n in range(3):
        conversation(f"O{n}", scope="organization")
    for n in range(4):
        conversation(f"Grp{n}", kind="group",
                     members=[accounts["writer"], *world.teams[n][1:5]])
    for n in range(6):
        conversation(f"Dir{n}", kind="direct",
                     members=[accounts["writer"] if n % 2 else admin, world.teams[n][1]])
    for n in range(2):
        conversation(f"GG{n}", kind="group",
                     members=[accounts["manager"], *world.teams[n + 4][2:4]])
    db.add(CommsChannelAccess(
        org_id=org_id, conversation_id=world.conversations["K3"], subject="group",
        group_id=guest_readers.id, level="read", created_by=admin.id,
    ))
    db.add(CommsChannelAccess(
        org_id=org_id, category_id=category.id, subject="user",
        user_id=accounts["writer"].id, level="post", created_by=admin.id,
    ))
    db.flush()
    return world
