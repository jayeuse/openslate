"""Owned offline fixture: block the resolver, never open a network connection."""

from threading import Event


def main():
    from app.systems.comms.previews import child, fetch

    def blocked(*_args, **_kwargs):
        Event().wait()

    def forbidden(*_args, **_kwargs):
        raise AssertionError("Blocked resolver fixture cannot connect")

    fetch.resolve = blocked
    fetch.open_socket = forbidden
    return child.main()


if __name__ == "__main__":
    raise SystemExit(main())
