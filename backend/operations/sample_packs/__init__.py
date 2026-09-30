"""Organization-pack definitions for the generic sample-data engine."""

from operations.sample_packs.interface import OrganizationPack


def default_pack() -> OrganizationPack:
    from operations.sample_packs.registry import default_pack as resolve_default

    return resolve_default()


def get_pack(key: str | None = None) -> OrganizationPack:
    from operations.sample_packs.registry import get_pack as resolve_pack

    return resolve_pack(key)


__all__ = ["OrganizationPack", "default_pack", "get_pack"]
