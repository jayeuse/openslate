"""Independent committed-state evidence for settings and private preference commands."""

from sqlalchemy import select

from app.systems.comms.settings.models import (
    CommsCapabilityGrant,
    CommsMemberPreferences,
    CommsPersonalPreferences,
    CommsSettingLock,
    CommsSettings,
)
from app.systems.manage.audit.models import AuditLog


def stored(case, org=None):
    org = org or case.world.first
    with case.world.session(org) as db:
        return {
            model.__tablename__: db.execute(
                select(model.__table__)
                .where(
                    model.org_id == org.id,
                )
                .order_by(model.id)
            ).all()
            for model in (
                CommsCapabilityGrant,
                CommsMemberPreferences,
                CommsPersonalPreferences,
                CommsSettingLock,
                CommsSettings,
                AuditLog,
            )
        }
