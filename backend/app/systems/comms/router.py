"""Composition of S17–S20; moderation and later families remain separate."""

from fastapi import APIRouter

from app.systems.comms.conversations.router import router as conversations
from app.systems.comms.files.router import router as files
from app.systems.comms.messages.interactions import router as interactions
from app.systems.comms.messages.router import router as messages
from app.systems.comms.messages.threads import router as threads
from app.systems.comms.realtime.router import router as realtime
from app.systems.comms.search import router as search
from app.systems.comms.settings.preferences import router as preferences
from app.systems.comms.settings.router import router as settings

router = APIRouter()
router.include_router(messages)
router.include_router(conversations)
router.include_router(preferences)
router.include_router(settings)
router.include_router(threads)
router.include_router(interactions)
router.include_router(files)
router.include_router(search)
router.include_router(realtime)
