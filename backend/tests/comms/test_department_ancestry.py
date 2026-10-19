"""Real Comms audit attribution before flush, after detachment and after parent deletion."""

import pytest
from sqlalchemy import bindparam, event, text
from uuid6 import uuid7

from app.core.database.base import Base
from app.systems.manage.audit.department_ancestry import DepartmentAncestry
from app.systems.sandbox.departments.models import Department
from tests.comms.conftest import NOW

pytestmark = pytest.mark.integration


def _seed_link_targets(world, org):
    # Structural metadata only, not a Comms upload/ownership-policy fixture (S18).
    with world.owner.begin() as connection:
        connection.execute(Base.metadata.tables["modules"].insert().values(
            id=org.module, org_id=org.id, department_id=org.department, module_name="Linked",
        ))
        connection.execute(Base.metadata.tables["records"].insert().values(
            id=org.record, org_id=org.id, module_id=org.module, data={},
        ))
        connection.execute(Base.metadata.tables["files"].insert().values(
            id=org.file, org_id=org.id, department_id=org.department,
            purpose="library_document", creator_id=org.author, filename="fixture.txt",
            expected_size=1, object_key=f"org/{org.id}/{org.file.hex}", state="awaiting_upload",
        ))


def _message(org, conversation_id):
    from app.systems.comms.messages.models import CommsMessage

    return CommsMessage(
        id=uuid7(), org_id=org.id, conversation_id=conversation_id, author_id=org.author,
        client_key=uuid7(), seq=1, body="Owned ancestry message", send_fingerprint=uuid7().hex * 2,
    )


def _message_children(org, conversation_id, message_id):
    from app.systems.comms.messages.interaction_models import (
        CommsMention,
        CommsReaction,
        CommsThread,
    )
    from app.systems.comms.messages.models import CommsMessageRevision

    return [
        CommsMessageRevision(id=uuid7(), org_id=org.id, message_id=message_id,
                             author_id=org.author, body="Previous private content"),
        CommsThread(id=uuid7(), org_id=org.id, conversation_id=conversation_id,
                    root_message_id=message_id),
        CommsReaction(id=uuid7(), org_id=org.id, message_id=message_id,
                      user_id=org.author, emoji="👍"),
        CommsMention(id=uuid7(), org_id=org.id, message_id=message_id, user_id=org.peer),
    ]


def _assert_stamps(world, org, action, expected):
    with world.owner.connect() as connection:
        rows = connection.execute(text(
            "SELECT entity_id,department_id,org_id,performed_by FROM audit_logs "
            "WHERE entity_id IN :ids AND action=:action"
        ).bindparams(bindparam("ids", expanding=True)), {
            "ids": list(expected), "action": action,
        }).all()
    assert len(rows) == len(expected)
    assert {row.entity_id: row.department_id for row in rows} == expected
    assert all(row.org_id == org.id and row.performed_by == org.author for row in rows)


def test_new_dirty_and_deleted_parent_chains_stamp_current_department_and_keep_history(comms_world):
    from app.systems.comms.conversations.models import (
        CommsCategory,
        CommsConversation,
        CommsConversationGroup,
        CommsMember,
    )
    from app.systems.comms.messages.link_models import (
        CommsMessageAttachment,
        CommsMessageRecordLink,
    )
    from app.systems.comms.messages.models import CommsMessage, CommsMessageRevision
    from app.systems.comms.settings.models import CommsCapabilityGrant, CommsSettings

    org = comms_world.first
    _seed_link_targets(comms_world, org)
    department = Department(id=uuid7(), org_id=org.id, department_name="Original Comms owner")
    category = CommsCategory(id=uuid7(), org_id=org.id, name="Owned category", position=0,
                             department_id=department.id)
    conversation = CommsConversation(
        id=uuid7(), org_id=org.id, kind="channel", scope="department",
        category_id=category.id, department_id=department.id, name="Department channel",
        topic="", position=0, created_by=org.author,
    )
    message = _message(org, conversation.id)
    children = _message_children(org, conversation.id, message.id)
    children += [
        CommsMember(id=uuid7(), org_id=org.id, conversation_id=conversation.id,
                    user_id=org.author, role="member", joined_at=NOW),
        CommsMessageAttachment(id=uuid7(), org_id=org.id, message_id=message.id, file_id=org.file),
        CommsMessageRecordLink(id=uuid7(), org_id=org.id, message_id=message.id,
                              record_id=org.record, module_id=org.module),
    ]
    for scope, owner in (
        ("category", {"category_id": category.id}),
        ("channel", {"conversation_id": conversation.id}),
    ):
        children += [
            CommsConversationGroup(id=uuid7(), org_id=org.id, subject="group", group_id=org.group,
                                   level="read", **owner),
            CommsSettings(id=uuid7(), org_id=org.id, scope=scope, values={}, **owner),
            CommsCapabilityGrant(id=uuid7(), org_id=org.id, scope=scope, capability="reply",
                                 subject="group", group_id=org.group, granted=True, **owner),
        ]
    rows = [department, category, conversation, message, *children]
    identities = [(type(row), row.id) for row in rows]
    old_department_id = department.id
    category_id, conversation_id, message_id = category.id, conversation.id, message.id
    with comms_world.session(org) as db:
        db.add_all(rows)
        with db.no_autoflush:
            ancestry = DepartmentAncestry(db, rows)
            for row in rows:
                resolved = ancestry.for_instance(row)
                assert (resolved.id if isinstance(resolved, Department) else resolved) == (
                    old_department_id
                )
        db.commit()
    created = {identity: old_department_id for _, identity in identities}
    _assert_stamps(comms_world, org, "create", created)

    new_department_id, new_revision_id = uuid7(), uuid7()
    with comms_world.session(org) as db:
        db.add(Department(id=new_department_id, org_id=org.id, department_name="New Comms owner"))
        db.commit()
        category = db.get(CommsCategory, category_id)
        conversation = db.get(CommsConversation, conversation_id)
        message = db.get(CommsMessage, message_id)
        assert category is not None and conversation is not None and message is not None
        # The database still names the old department when before_flush captures this batch.
        category.department_id = new_department_id
        conversation.department_id = new_department_id
        message.body = "Changed with the parent"
        db.add(CommsMessageRevision(
            id=new_revision_id, org_id=org.id, message_id=message_id,
            author_id=org.author, body="Owned ancestry message",
        ))
        db.commit()
    _assert_stamps(comms_world, org, "update", {
        category_id: new_department_id, conversation_id: new_department_id,
        message_id: new_department_id,
    })
    _assert_stamps(comms_world, org, "create", {new_revision_id: new_department_id})
    _assert_stamps(comms_world, org, "create", created)

    # Delete the actual descendants and their parents together. Attribution must be
    # captured before flush; re-querying after DELETE cannot recover this history.
    deleting = identities[1:] + [
        (CommsMessageRevision, new_revision_id), (Department, new_department_id),
    ]
    with comms_world.session(org) as db:
        loaded = [db.get(model, identity) for model, identity in deleting]
        assert all(row is not None for row in loaded)
        with db.no_autoflush:
            for row in loaded:
                db.delete(row)
        db.commit()
    with comms_world.owner.connect() as connection:
        assert connection.scalar(text("SELECT count(*) FROM departments WHERE id=:id"), {
            "id": new_department_id,
        }) == 0
        assert connection.scalar(text("SELECT count(*) FROM comms_messages WHERE id=:id"), {
            "id": message_id,
        }) == 0
    _assert_stamps(comms_world, org, "delete", {
        identity: new_department_id for _, identity in deleting
    })
    _assert_stamps(comms_world, org, "create", created)


def test_clearing_category_department_keeps_new_child_audit_unscoped(comms_world):
    from app.systems.comms.conversations.models import CommsCategory
    from app.systems.comms.settings.models import CommsSettings

    org = comms_world.first
    category_id, settings_id = uuid7(), uuid7()
    with comms_world.session(org) as db:
        db.add(CommsCategory(
            id=category_id, org_id=org.id, name="Owned category", position=0,
            department_id=org.department,
        ))
        db.commit()

    with comms_world.session(org) as db:
        category = db.get(CommsCategory, category_id)
        assert category is not None
        assert category.department_id == org.department
        with db.no_autoflush:
            category.department = None
            db.add(CommsSettings(
                id=settings_id, org_id=org.id, scope="category", category_id=category_id,
                values={},
            ))
        db.commit()

    with comms_world.owner.connect() as connection:
        assert connection.execute(text(
            "SELECT department_id FROM comms_categories WHERE org_id=:org AND id=:id"
        ), {"org": org.id, "id": category_id}).one() == (None,)
    _assert_stamps(comms_world, org, "create", {category_id: org.department})
    _assert_stamps(comms_world, org, "create", {settings_id: None})


def test_clearing_category_department_fk_keeps_new_child_audit_unscoped(comms_world):
    from app.systems.comms.conversations.models import CommsCategory
    from app.systems.comms.settings.models import CommsSettings

    org = comms_world.first
    category_id, settings_id = uuid7(), uuid7()
    with comms_world.session(org) as db:
        db.add(CommsCategory(
            id=category_id, org_id=org.id, name="Owned category", position=0,
            department_id=org.department,
        ))
        db.commit()

    with comms_world.session(org) as db:
        category = db.get(CommsCategory, category_id)
        assert category is not None
        department = category.department
        assert department is not None
        assert department.id == org.department
        with db.no_autoflush:
            category.department_id = None
            db.add(CommsSettings(
                id=settings_id, org_id=org.id, scope="category", category_id=category_id,
                values={},
            ))
        db.commit()

    with comms_world.owner.connect() as connection:
        assert connection.execute(text(
            "SELECT department_id FROM comms_categories WHERE org_id=:org AND id=:id"
        ), {"org": org.id, "id": category_id}).one() == (None,)
    _assert_stamps(comms_world, org, "create", {category_id: org.department})
    _assert_stamps(comms_world, org, "create", {settings_id: None})


@pytest.mark.parametrize("parent_state", ["unloaded", "detached"])
def test_persisted_parent_reads_are_batched_across_distinct_message_chains(
    comms_world, parent_state,
):
    from app.systems.comms.conversations.models import CommsCategory, CommsConversation
    from app.systems.comms.messages.models import CommsMessage, CommsMessageRevision

    org = comms_world.first
    query_counts = []
    for count in (1, 24):
        parents = []
        with comms_world.owner.begin() as connection:
            for _ in range(count):
                department_id, category_id, conversation_id, message_id = (
                    uuid7() for _ in range(4)
                )
                for table, values in (
                    ("departments", {"id": department_id, "department_name": str(department_id)}),
                    ("comms_categories", {"id": category_id, "name": "Batch", "position": 0,
                                          "department_id": department_id}),
                    ("comms_conversations", {
                        "id": conversation_id, "kind": "channel", "scope": "department",
                        "category_id": category_id, "department_id": department_id,
                        "name": "Batch", "topic": "", "position": 0, "created_by": org.author,
                    }),
                    ("comms_messages", {
                        "id": message_id, "conversation_id": conversation_id,
                        "author_id": org.author, "seq": 1, "client_key": uuid7(), "body": "Batch",
                        "send_fingerprint": uuid7().hex * 2,
                    }),
                ):
                    connection.execute(Base.metadata.tables[table].insert().values(
                        org_id=org.id, **values,
                    ))
                parents.append((department_id, category_id, conversation_id, message_id))
        expected = {}
        with comms_world.session(org) as db:
            if parent_state == "detached":
                detached = [
                    db.get(model, identity)
                    for _, category_id, conversation_id, message_id in parents
                    for model, identity in (
                        (CommsCategory, category_id), (CommsConversation, conversation_id),
                        (CommsMessage, message_id),
                    )
                ]
                assert all(row is not None for row in detached)
                db.expunge_all()
                assert not db.identity_map
            for department_id, _, _, message_id in parents:
                child = CommsMessageRevision(
                    id=uuid7(), org_id=org.id, message_id=message_id,
                    author_id=org.author, body="Persisted ancestor",
                )
                expected[child.id] = department_id
                db.add(child)
            # Exclude initial transaction scope binding; count real SELECTs during
            # audited commit, not calls to a mock or queries copied from the resolver.
            connection = db.connection()
            selects = []

            def count_select(
                _connection, _cursor, statement, _parameters, _context, _many, captured=selects,
            ):
                if statement.lstrip().upper().startswith("SELECT"):
                    captured.append(statement)

            event.listen(connection, "before_cursor_execute", count_select)
            try:
                db.commit()
            finally:
                event.remove(connection, "before_cursor_execute", count_select)
            query_counts.append(len(selects))
        _assert_stamps(comms_world, org, "create", expected)
    # At most message -> conversation -> category batches, not one lookup per child.
    assert 1 <= query_counts[0] <= 3
    assert 1 <= query_counts[1] <= query_counts[0]


def test_direct_group_workspace_and_unrelated_link_targets_do_not_invent_a_department(comms_world):
    from app.systems.comms.conversations.models import (
        CommsConversation,
        CommsConversationGroup,
        CommsDirectBlock,
    )
    from app.systems.comms.messages.link_models import (
        CommsMessageAttachment,
        CommsMessageRecordLink,
    )
    from app.systems.comms.settings.models import (
        CommsCapabilityGrant,
        CommsSettingLock,
        CommsSettings,
    )

    org = comms_world.first
    _seed_link_targets(comms_world, org)
    expected = {}
    with comms_world.session(org) as db:
        for kind, scope in (
            ("direct", "members"), ("group", "members"),
            ("channel", "organization"), ("channel", "groups"),
        ):
            conversation = CommsConversation(
                id=uuid7(), org_id=org.id, kind=kind, scope=scope,
                name="No department", topic="", position=0, created_by=org.author,
            )
            message = _message(org, conversation.id)
            rows = [conversation, message, *_message_children(org, conversation.id, message.id)]
            rows.append(CommsMessageRecordLink(
                id=uuid7(), org_id=org.id, message_id=message.id,
                record_id=org.record, module_id=org.module,
            ))
            if scope == "groups":
                rows += [
                    CommsConversationGroup(id=uuid7(), org_id=org.id,
                                           conversation_id=conversation.id, subject="group",
                                           group_id=org.group, level="post"),
                    CommsMessageAttachment(id=uuid7(), org_id=org.id,
                                           message_id=message.id, file_id=org.file),
                ]
            expected.update({row.id: None for row in rows})
            db.add_all(rows)
        workspace = [
            CommsSettings(id=uuid7(), org_id=org.id, scope="workspace", values={}),
            CommsSettingLock(id=uuid7(), org_id=org.id, namespace="capability", key="reply"),
            CommsCapabilityGrant(id=uuid7(), org_id=org.id, scope="workspace",
                                 capability="reply", subject="group", group_id=org.group,
                                 granted=True),
            CommsDirectBlock(id=uuid7(), org_id=org.id,
                             user_id=org.author, blocked_user_id=org.peer),
        ]
        expected.update({row.id: None for row in workspace})
        db.add_all(workspace)
        db.commit()
    _assert_stamps(comms_world, org, "create", expected)
