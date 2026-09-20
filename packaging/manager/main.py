"""PyInstaller entrypoint for the OpenSlate Manager package."""

from __future__ import annotations

from openslate_manager.app import main

if __name__ == "__main__":
    raise SystemExit(main())
