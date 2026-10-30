"""Master data of the plant: customers, products, materials, suppliers and work centers.

Links use only record indexes and the profile's counts (the shared engine gives a link
rule no seed or date), so every choice here that a link depends on uses the pack's own
fixed random stream. Records below ``PINNED`` keep the named business cases.
"""

from __future__ import annotations

import random
from collections.abc import Callable, Mapping
from functools import cache, lru_cache, wraps

from operations.sample.packs.manufacturer import vocabulary as words
from operations.sample.packs.manufacturer.realism import (
    CUSTOMER_CHANNELS,
    MATERIAL_STATUS,
    PRODUCT_CLASSES,
)
from operations.sample.realism import skewed_parent, weighted_label

Counts = Mapping[str, int]
Frozen = tuple[tuple[str, int], ...]
PINNED = 10


def rng(*parts: object) -> random.Random:
    return random.Random("mfg:" + ":".join(str(part) for part in parts))


def draw(module: str, index: int, weights: Mapping[str, float], tag: str = "class") -> str:
    return weighted_label(rng(module, index, tag), weights)


def between(module: str, index: int, low: int, high: int, tag: str = "wd") -> int:
    return rng(module, index, tag).randint(low, high)


def frozen(counts: Counts) -> Frozen:
    return tuple(sorted(counts.items()))


def counted[T](rule: Callable[[int, Counts], T]) -> Callable[[int, Counts], T]:
    """Cache a rule of (index, counts); a profile's counts never change during a build."""

    @cache
    def cached(index: int, frozen_counts: Frozen) -> T:
        return rule(index, dict(frozen_counts))

    @wraps(rule)
    def wrapper(index: int, counts: Counts) -> T:
        return cached(index, frozen(counts))

    return wrapper


# Customers.
_PINNED_CHANNELS = ("Retail", "Foodservice", "Wholesale", "Retail", "Private label",
                    "Wholesale", "Foodservice", "Wholesale", "Retail", "Co-man")  # fmt: skip


@cache
def customer_channel(customer: int) -> str:
    if customer < PINNED:
        return _PINNED_CHANNELS[customer]
    return draw("customers", customer, CUSTOMER_CHANNELS, "channel")


def customer_of_order(order: int, counts: Counts) -> int:
    return skewed_parent("customer_orders", order, counts["customers"])


@lru_cache(maxsize=16)
def _ordering_customers(frozen_counts: Frozen) -> frozenset[int]:
    counts = dict(frozen_counts)
    return frozenset(customer_of_order(order, counts) for order in range(counts["sales_orders"]))


@counted
def customer_status(customer: int, counts: Counts) -> str:
    if customer < PINNED:
        return "Active"
    if customer in _ordering_customers(frozen(counts)):
        return "Credit hold" if rng("customers", customer, "hold").random() < 0.08 else "Active"
    return "Prospect" if rng("customers", customer, "idle").random() < 0.55 else "Inactive"


def customer_name(customer: int) -> str:
    channel = customer_channel(customer)
    places, nouns = words.CUSTOMER_PLACES, words.CUSTOMER_NOUNS[channel]
    place = places[customer % len(places)]
    noun = nouns[(customer // len(places) + 3 * (customer % len(places))) % len(nouns)]
    return f"{place} {noun}"


# Products: a product line in one pack size; the pack decides the filling line.
_PACK_START = {1: 0, 2: 1, 3: 2, 4: 0}
_PACK_LINE = (1, 2, 3, 3, 1, 2)
_FAMILY_PRICE = {"BBQ": 1.0, "Ketchup and tomato": 0.8, "Salsa": 1.0,
                 "Mustard and dressing": 0.9, "Hot and wing": 1.2, "Relish": 0.9,
                 "Dry seasoning": 1.0}  # fmt: skip


@cache
def product_line(product: int) -> tuple[str, str, int, bool, str, int]:
    return words.PRODUCT_LINES[product % len(words.PRODUCT_LINES)]


@cache
def product_pack_index(product: int) -> int:
    line = product_line(product)
    return (_PACK_START[line[2]] + product // len(words.PRODUCT_LINES)) % 6


def product_pack(product: int) -> tuple[str, int, float]:
    packs = words.DRY_PACKS if product_line(product)[1] == "Dry seasoning" else words.SAUCE_PACKS
    return packs[product_pack_index(product)]


def product_name(product: int) -> str:
    return f"{product_line(product)[0]} {product_pack(product)[0]}"


def product_filling_line(product: int) -> int:
    if product_line(product)[1] == "Dry seasoning":
        return 4
    return _PACK_LINE[product_pack_index(product)]


@cache
def product_class(product: int) -> str:
    return "Active" if product < PINNED else draw("products", product, PRODUCT_CLASSES)


@cache
def list_price(product: int) -> float:
    price = product_pack(product)[2] * _FAMILY_PRICE[product_line(product)[1]]
    if product % 3 == 0:
        return float(max(10, 5 * round(price / 5)))  # Many list prices are round.
    return round(price, 2)


@lru_cache(maxsize=16)
def products_with(count: int, classes: frozenset[str]) -> tuple[int, ...]:
    found = tuple(item for item in range(count) if product_class(item) in classes)
    return found or tuple(range(count))


def sellable(counts: Counts) -> tuple[int, ...]:
    return products_with(counts["products"], frozenset({"Active", "Phase-out"}))


@lru_cache(maxsize=16)
def _bom_table(products: int, boms: int) -> tuple[int, ...]:
    """The product of each formula version: one current formula for most products, an older
    version for some, and none for a few that the plant no longer makes."""
    stream = rng("boms", products, boms)
    makers = [item for item in range(products) if item < PINNED or stream.random() >= 0.08]
    table = makers[:boms]
    while len(table) < boms:
        table.append(stream.choice(makers))
    return tuple(table)


def bom_product(bom: int, counts: Counts) -> int:
    return _bom_table(counts["products"], counts["boms"])[bom]


# Materials.
@cache
def material_info(material: int) -> tuple[str, str, str, float, str, int]:
    base = words.MATERIALS[material % len(words.MATERIALS)]
    description, kind, unit, price, allergen, lead = base
    variants = words.MATERIAL_VARIANTS[kind]
    variant = variants[(material // len(words.MATERIALS)) % len(variants)]
    factor = 1.0 if not variant else 1.15
    return f"{description}{variant}", kind, unit, round(price * factor, 2), allergen, lead


@cache
def material_status(material: int) -> str:
    return "Active" if material < PINNED else draw("materials", material, MATERIAL_STATUS)


# Suppliers: each material category is bought from suppliers of that category.
_SUPPLIER_CYCLE = ("Ingredient", "Packaging", "Ingredient", "MRO", "Packaging", "Ingredient",
                   "Service", "Packaging", "Ingredient", "MRO")  # fmt: skip
_MATERIAL_CATEGORY = {"Ingredient": "Ingredient", "Packaging, primary": "Packaging",
                      "Packaging, secondary": "Packaging", "MRO": "MRO"}  # fmt: skip


@cache
def supplier_category(supplier: int) -> str:
    return _SUPPLIER_CYCLE[supplier % len(_SUPPLIER_CYCLE)]


@cache
def supplier_name(supplier: int) -> str:
    category = supplier_category(supplier)
    rank = sum(supplier_category(item) == category for item in range(supplier))
    places, nouns = words.SUPPLIER_PLACES, words.SUPPLIER_NOUNS[category]
    place = places[rank % len(places)]
    noun = nouns[(rank // len(places) + rank) % len(nouns)]
    return f"{place} {noun} {words.SUPPLIER_SUFFIXES[supplier % len(words.SUPPLIER_SUFFIXES)]}"


@lru_cache(maxsize=16)
def suppliers_of(category: str, count: int) -> tuple[int, ...]:
    found = tuple(item for item in range(count) if supplier_category(item) == category)
    return found or tuple(range(count))


def material_supplier(material: int, counts: Counts, alternate: bool = False) -> int:
    pool = suppliers_of(_MATERIAL_CATEGORY[material_info(material)[1]], counts["suppliers"])
    return pool[(material * 7 + int(alternate)) % len(pool)]


# Work centers: kettles and filling lines alternate, K1, L1, K2, L2 and so on.
@cache
def work_center(center: int) -> tuple[str, str, str]:
    number = center // 2 + 1
    if center % 2 == 0:
        return f"K{number}", f"Kettle {number}, 2,000 L steam-jacketed", "Kettle"
    if number % 4 == 0:
        return f"L{number}", f"Line {number}, dry blending and pouches", "Blending"
    kind = ("hot-fill glass jars", "hot-fill PET squeeze bottles",
            "foodservice jugs and pouches")[(number - 1) % 4]  # fmt: skip
    return f"L{number}", f"Line {number}, {kind}", "Filling line"


def filling_lines(counts: Counts) -> tuple[int, ...]:
    total = counts["work_centers"]
    return tuple(item for item in range(1, total, 2)) or (0,)


def product_work_centers(product: int, counts: Counts) -> tuple[int, ...]:
    """The filling lines that run the product's pack: L1, L5, L9 for glass, and so on."""
    lines = filling_lines(counts)
    kind = (product_filling_line(product) - 1) % 4
    matching = tuple(item for item in lines if (item // 2) % 4 == kind)
    return matching or lines
