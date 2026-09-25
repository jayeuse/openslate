"""Aggregate local Identity and administrator session routes under one API router."""

from fastapi import APIRouter

from app.systems.access.auth.router import router as identity_router
from app.systems.access.users.invitations_router import router as invitations_router
from app.systems.access.users.sessions_router import auth_router as self_sessions_router
from app.systems.access.users.sessions_router import router as admin_sessions_router

router = APIRouter()
router.include_router(identity_router)
router.include_router(invitations_router)
router.include_router(self_sessions_router)
router.include_router(admin_sessions_router)
