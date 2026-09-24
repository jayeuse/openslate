"""Aggregate Access policy administration routes."""

from fastapi import APIRouter

from app.systems.access.policy.catalog_router import router as capability_catalog_router
from app.systems.access.policy.checks_router import router as access_checks_router
from app.systems.access.policy.configuration_router import router as group_configuration_router
from app.systems.access.policy.rule_batch_router import router as rule_batch_router
from app.systems.access.policy.rules_router import router as rule_management_router
from app.systems.access.service_identities.router import router as service_identities_router

router = APIRouter()
router.include_router(capability_catalog_router)
router.include_router(access_checks_router)
router.include_router(group_configuration_router)
router.include_router(rule_batch_router)
router.include_router(rule_management_router)
router.include_router(service_identities_router)
