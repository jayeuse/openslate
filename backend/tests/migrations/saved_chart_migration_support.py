"""Owned disposable fixtures for saved-chart current-schema contracts."""

from dataclasses import dataclass
from uuid import UUID

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool
from uuid6 import uuid7

from app.systems.sandbox.departments.models import Department
from tests.conftest import (
    alembic_heads,
    create_member,
    create_organization,
    guarded_create_engine,
)
from tests.operations.migration_support import guarded_migration_environment


def database_head() -> str:
    [head] = alembic_heads()
    return head


@dataclass(repr=False)
class ChartMigrationFixture:
    environment: dict[str, str]
    owner: Engine
    runtime: Engine
    ids: dict[str, UUID]

    def revision(self) -> str:
        with self.owner.connect() as connection:
            return str(connection.scalar(text("SELECT version_num FROM public.alembic_version")))

    def clean(self) -> None:
        with self.owner.begin() as connection:
            for table, column, identity in (
                ("dashboard_widgets", "dashboard_id", self.ids["dashboard"]),
                ("charts", "module_id", self.ids["module"]),
                ("dashboards", "id", self.ids["dashboard"]),
                ("boards", "id", self.ids["board"]),
                ("modules", "id", self.ids["module"]),
                ("departments", "id", self.ids["department"]),
                ("memberships", "user_id", self.ids["actor"]),
                ("users", "id", self.ids["actor"]),
                ("organizations", "id", self.ids["org"]),
            ):
                connection.execute(text(f"DELETE FROM public.{table} WHERE {column}=:id"),
                                   {"id": identity})


@pytest.fixture
def chart_migration():
    environment = guarded_migration_environment()
    fixture = ChartMigrationFixture(
        environment,
        guarded_create_engine(environment["MIGRATION_DATABASE_URL"], poolclass=NullPool),
        guarded_create_engine(environment["TEST_DATABASE_URL"], poolclass=NullPool),
        {key: uuid7() for key in (
            "org", "actor", "department", "module", "board", "dashboard", "chart",
        )},
    )
    try:
        assert fixture.revision() == database_head()
        with Session(fixture.owner) as db:
            organization = create_organization(db, id=fixture.ids["org"])
            create_member(db, organization, id=fixture.ids["actor"],
                          email=f"{fixture.ids['actor'].hex}@example.test",
                          username="s26_" + fixture.ids["actor"].hex)
            db.connection().execute(Department.__table__.insert().values(
                id=fixture.ids["department"], org_id=organization.id,
                department_name="S26 " + fixture.ids["department"].hex,
            ))
            for statement in (
                "INSERT INTO public.modules(id,org_id,department_id,module_name) "
                "VALUES(:module,:org,:department,'Source')",
                "INSERT INTO public.boards(id,org_id,scope,name) "
                "VALUES(:board,:org,'project','Owned Board')",
                "INSERT INTO public.dashboards(id,org_id,department_id,name) "
                "VALUES(:dashboard,:org,:department,'Owned Dashboard')",
            ):
                db.connection().execute(text(statement), fixture.ids)
            db.commit()
        yield fixture
    finally:
        fixture.clean()
        fixture.runtime.dispose()
        fixture.owner.dispose()
