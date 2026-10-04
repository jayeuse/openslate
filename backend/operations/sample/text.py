"""Pack-neutral text generator entry points used by record construction."""

from __future__ import annotations

from collections.abc import Mapping

from operations.sample.catalog import module_counts
from operations.sample.packs import default_pack
from operations.sample.packs.interface import OrganizationPack


def _pack(organization: OrganizationPack | None) -> OrganizationPack:
    return organization or default_pack()


def choice_label(
    module_key: str,
    field_key: str,
    index: int,
    seed: int,
    organization: OrganizationPack | None = None,
) -> str:
    pack = _pack(organization)
    module = next(item for item in pack.catalog.modules if item.key == module_key)
    field = next(item for item in module.fields if item.key == field_key)
    return field.options[(index + seed) % len(field.options)]


def customer_name(index: int, seed: int, organization: OrganizationPack | None = None) -> str:
    pack = _pack(organization)
    return pack.text.customer_name(index, seed)


def supplier_name(index: int, organization: OrganizationPack | None = None) -> str:
    pack = _pack(organization)
    return pack.text.supplier_name(index)


def equipment_name(index: int, organization: OrganizationPack | None = None) -> str:
    return _pack(organization).text.equipment_name(index)


def product_name(index: int, seed: int, organization: OrganizationPack | None = None) -> str:
    return _pack(organization).text.product_name(index, seed)


def warehouse_name(index: int, seed: int, organization: OrganizationPack | None = None) -> str:
    return _pack(organization).text.warehouse_name(index, seed)


def site_place(index: int, seed: int, organization: OrganizationPack | None = None) -> str:
    return _pack(organization).text.site_place(index, seed)


def site_name(
    index: int,
    seed: int,
    counts: Mapping[str, int] | None = None,
    organization: OrganizationPack | None = None,
) -> str:
    pack = _pack(organization)
    return pack.text.site_name(index, seed, dict(counts or module_counts("standard", pack)))


def reference_code(
    module_key: str, index: int, seed: int, organization: OrganizationPack | None = None
) -> str | None:
    return _pack(organization).text.reference_code(module_key, index, seed)


def record_title(
    module_key: str,
    index: int,
    seed: int,
    counts: Mapping[str, int],
    organization: OrganizationPack | None = None,
) -> str:
    return _pack(organization).text.record_title(module_key, index, seed, counts)


def note_text(
    module_key: str,
    field_key: str,
    index: int,
    seed: int,
    organization: OrganizationPack | None = None,
) -> str:
    return _pack(organization).text.note_text(module_key, field_key, index, seed)


def email_value(
    module_key: str,
    index: int,
    seed: int,
    counts: Mapping[str, int],
    organization: OrganizationPack | None = None,
) -> str:
    return _pack(organization).text.email_value(module_key, index, seed, counts)


def phone_value(index: int, seed: int, organization: OrganizationPack | None = None) -> str:
    return _pack(organization).text.phone_value(index, seed)


def serial_value(index: int, seed: int, organization: OrganizationPack | None = None) -> str:
    return _pack(organization).text.serial_value(index, seed)


def url_value(
    module_key: str, index: int, seed: int, organization: OrganizationPack | None = None
) -> str:
    return _pack(organization).text.url_value(module_key, index, seed)
