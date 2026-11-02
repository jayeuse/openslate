"""PyInstaller entrypoint for the Slate Operations Manager package."""

from __future__ import annotations

from slateops_manager.app import main

if __name__ == "__main__":
    raise SystemExit(main())
