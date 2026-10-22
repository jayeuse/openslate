"""Composition of S17–S20; moderation and later families remain separate."""

from fastapi import APIRouter

from app.systems.comms.conversations.router import router as conversations
from app.systems.comms.direct_candidates import router as direct_candidates
from app.systems.comms.files.router import router as files
from app.systems.comms.jobs.exports import router as exports
from app.systems.comms.jobs.retention import router as retention
from app.systems.comms.jobs.schedules import router as schedules
from app.systems.comms.messages.interactions import router as interactions
from app.systems.comms.messages.router import router as messages
from app.systems.comms.messages.threads import router as threads
from app.systems.comms.moderation.lifecycle import router as lifecycle
from app.systems.comms.moderation.router import router as moderation
from app.systems.comms.realtime.router import router as realtime
from app.systems.comms.search import router as search
from app.systems.comms.settings.history import router as history
from app.systems.comms.settings.preferences import router as preferences
from app.systems.comms.settings.router import router as settings
from app.systems.comms.templates.router import router as templates

router = APIRouter()
router.include_router(messages)
router.include_router(conversations)
router.include_router(direct_candidates)
router.include_router(preferences)
router.include_router(settings)
router.include_router(history)
router.include_router(threads)
router.include_router(interactions)
router.include_router(files)
router.include_router(search)
router.include_router(realtime)
router.include_router(moderation)
router.include_router(lifecycle)
router.include_router(schedules)
router.include_router(retention)
router.include_router(exports)
router.include_router(templates)
