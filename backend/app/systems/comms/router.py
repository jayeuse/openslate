"""Composition of the implemented S17 families; later Comms APIs remain unregistered."""

from fastapi import APIRouter

from app.systems.comms.conversations.router import router as conversations
from app.systems.comms.messages.router import router as messages
from app.systems.comms.settings.preferences import router as preferences
from app.systems.comms.settings.router import router as settings

router = APIRouter()
router.include_router(messages)
router.include_router(conversations)
router.include_router(preferences)
router.include_router(settings)
