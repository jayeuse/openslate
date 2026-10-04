"""Compatibility access for the registered pack's marker allow-list."""

from operations.sample.packs import default_pack

TRADE_PHRASES = default_pack().text.trade_phrases
