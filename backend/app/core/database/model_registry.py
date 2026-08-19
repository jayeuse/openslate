"""Import all ORM models so runtime metadata and relationship mappings are complete."""

from app.systems.audit.models import AuditLog  # noqa: F401
from app.systems.departments.models import Department  # noqa: F401
from app.systems.fields.models import Field  # noqa: F401
from app.systems.modules.models import Module  # noqa: F401
from app.systems.records.models import Record  # noqa: F401
from app.systems.users.models import Role, User  # noqa: F401
