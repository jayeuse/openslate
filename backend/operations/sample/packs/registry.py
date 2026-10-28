"""Registry for packs available to the operator CLI."""

from __future__ import annotations

from operations.sample.packs.clinic import PACK as _CLINIC_PACK
from operations.sample.packs.fmcg_distributor import PACK as _FMCG_DISTRIBUTOR_PACK
from operations.sample.packs.harbor import PACK as _FIRST_PACK
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.local_government import PACK as _LOCAL_GOVERNMENT_PACK
from operations.sample.packs.nonprofit import PACK as _NONPROFIT_PACK
from operations.sample.packs.school import PACK as _SCHOOL_PACK

_PACKS: tuple[OrganizationPack, ...] = (
    _FIRST_PACK, _SCHOOL_PACK, _CLINIC_PACK, _NONPROFIT_PACK, _LOCAL_GOVERNMENT_PACK,
    _FMCG_DISTRIBUTOR_PACK,
)  # fmt: skip


def default_pack() -> OrganizationPack:
    return _PACKS[0]


def get_pack(key: str | None = None) -> OrganizationPack:
    selected = default_pack().identity.key if key is None else key
    match = next((pack for pack in _PACKS if pack.identity.key == selected), None)
    if match is None:
        raise ValueError(f"Unknown organization pack: {selected}")
    return match


def pack_keys() -> tuple[str, ...]:
    return tuple(pack.identity.key for pack in _PACKS)
