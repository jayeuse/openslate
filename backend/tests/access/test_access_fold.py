"""The access fold owns rules 1 and 3 to 6 of scope.py, without a database.

The SQL reads (live rows of live groups and memberships, and each reachable module's
department) and the account check (rule 2) stay in ``scope._resolve``; the stack tests
in ``test_scope_integration.py`` own them.
"""

from uuid import UUID

import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.systems.access.policy.models import AccessLevel
from app.systems.access.policy.scope import AccessRow, _fold_access, rank
from tests.property_support import PROPERTY

READ, WRITE, MANAGE = AccessLevel.READ, AccessLevel.WRITE, AccessLevel.MANAGE
G1, G2, G3, G4 = UUID(int=0x61), UUID(int=0x62), UUID(int=0x63), UUID(int=0x64)
D1, D2 = UUID(int=0xD1), UUID(int=0xD2)
M1, M2, M3 = UUID(int=0x11), UUID(int=0x12), UUID(int=0x23)
# M1 and M2 sit in D1, M3 in D2: what the module read returns for these rows.
MODULES = {M1: D1, M2: D1, M3: D2}

FOLD_CASES = [
    pytest.param(
        "member",
        [(G1, D1, None, "write")],
        {M1: WRITE, M2: WRITE},
        {D1: WRITE},
        {M1: D1, M2: D1},
        id="department-row-covers-its-modules-only",
    ),
    pytest.param(
        "member",
        [(G1, D1, None, "manage"), (G1, D1, M1, "read")],
        {M1: READ, M2: MANAGE},
        {D1: MANAGE},
        {M1: D1, M2: D1},
        id="module-row-wins-in-its-group-even-when-lower",
    ),
    pytest.param(
        "member",
        [(G1, D1, None, "read"), (G1, D1, M1, "manage")],
        {M1: MANAGE, M2: READ},
        {D1: READ},
        {M1: D1, M2: D1},
        id="module-row-wins-in-its-group-when-higher",
    ),
    pytest.param(
        "member",
        [(G1, D1, M1, "read"), (G2, D1, None, "write")],
        {M1: WRITE, M2: WRITE},
        {D1: WRITE},
        {M1: D1, M2: D1},
        id="highest-across-groups-beats-a-lower-module-row",
    ),
    pytest.param(
        "member",
        [(G1, D1, None, "manage"), (G2, D1, None, "read")],
        {M1: MANAGE, M2: MANAGE},
        {D1: MANAGE},
        {M1: D1, M2: D1},
        id="highest-department-row-across-groups-first-high",
    ),
    pytest.param(
        "member",
        [(G1, D1, None, "read"), (G2, D1, None, "manage")],
        {M1: MANAGE, M2: MANAGE},
        {D1: MANAGE},
        {M1: D1, M2: D1},
        id="highest-department-row-across-groups-first-low",
    ),
    pytest.param(
        "member",
        [(G1, D2, M3, "write")],
        {M3: WRITE},
        {},
        {M3: D2},
        id="module-row-alone-opens-no-department-row",
    ),
    pytest.param(
        "guest",
        [(G1, D1, None, "manage"), (G2, D2, M3, "write")],
        {M1: READ, M2: READ, M3: READ},
        {D1: READ},
        {M1: D1, M2: D1, M3: D2},
        id="guest-is-capped-at-read",
    ),
    pytest.param("member", [], {}, {}, {}, id="no-row-no-access"),
]


@pytest.mark.parametrize(("role", "rows", "modules", "departments", "reach"), FOLD_CASES)
def test_fold_gives_each_module_and_department_its_level(
    role: str,
    rows: list[AccessRow],
    modules: dict[UUID, AccessLevel],
    departments: dict[UUID, AccessLevel],
    reach: dict[UUID, UUID],
) -> None:
    resolution = _fold_access(role, rows, MODULES)

    access = resolution.access
    assert access.unrestricted is False
    assert dict(access.modules) == modules
    assert dict(access.departments) == departments
    assert dict(access.module_departments) == reach
    assert resolution.guest is (role == "guest")


def test_fold_keeps_each_groups_own_rows_for_explanations() -> None:
    resolution = _fold_access(
        "guest", [(G1, D1, None, "manage"), (G1, D1, M1, "write"), (G2, D2, M3, "read")], MODULES
    )

    assert resolution.department_rows == {G1: {D1: MANAGE}}
    assert resolution.module_rows == {G1: {M1: WRITE}, G2: {M3: READ}}


_TARGETS = [(D1, None), (D2, None), (D1, M1), (D1, M2), (D2, M3)]
_LEVELS = st.sampled_from(["read", "write", "manage"])


def _rows(groups: list[UUID]) -> st.SearchStrategy[list[AccessRow]]:
    """Live rows as the database holds them: one per group and target."""

    return st.dictionaries(
        st.tuples(st.sampled_from(groups), st.sampled_from(_TARGETS)), _LEVELS
    ).map(
        lambda rows: [
            (group, department, module, level)
            for (group, (department, module)), level in rows.items()
        ]
    )


@PROPERTY
@given(rows=_rows([G1, G2, G3]))
def test_a_guest_reaches_what_a_member_reaches_and_only_reads(rows: list[AccessRow]) -> None:
    member = _fold_access("member", rows, MODULES).access
    guest = _fold_access("guest", rows, MODULES).access

    assert guest.modules.keys() == member.modules.keys()
    assert guest.departments.keys() == member.departments.keys()
    assert set(guest.modules.values()) <= {READ}
    assert set(guest.departments.values()) <= {READ}


@PROPERTY
@given(rows=_rows([G1, G2, G3]), extra=_rows([G4]))
def test_another_group_never_lowers_or_removes_access(
    rows: list[AccessRow], extra: list[AccessRow]
) -> None:
    before = _fold_access("member", rows, MODULES).access
    after = _fold_access("member", rows + extra, MODULES).access

    for module_id, level in before.modules.items():
        assert rank(after.modules.get(module_id)) >= rank(level)
    for department_id, level in before.departments.items():
        assert rank(after.departments.get(department_id)) >= rank(level)


@PROPERTY
@given(rows=_rows([G1, G2, G3]))
def test_an_administrator_is_unrestricted_whatever_the_rows(rows: list[AccessRow]) -> None:
    access = _fold_access("admin", rows, MODULES).access

    assert access.unrestricted is True
    assert access.module_ids(READ) is None
    assert access.managed_department_ids() is None
