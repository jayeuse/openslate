"""The deliberately minimal OS WebView surface."""

from __future__ import annotations

from .config import ManagerConfig


def open_manager_window(config: ManagerConfig) -> None:
    """Open the configured origin; window close returns from this function."""

    # Import here so configuration validation and packaging checks do not need a display.
    import webview

    webview.create_window("OpenSlate Manager", config.origin)
    webview.start()
