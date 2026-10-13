"""Sample datasets cached outside mutation runs and copied for each caller (plan item 20).

``build_dataset`` is deterministic for one profile, seed, anchor date and registry pack,
and it costs 0.12 s (Harbor Small) to 3.5 s (School Large). Outside mutation runs,
``sample_dataset`` builds each key once per test process and returns a deep copy, so every
caller owns its dataset and may change it without affecting another test. ``private_copy``
gives the same guarantee for a larger fixture that a test file builds from a dataset once.

The registry packs are immutable and every build already shares them, so a copy keeps
them shared instead of copying them. ``test_sample_dataset_cache.py`` proves that a copy
equals a fresh build and that copies are independent.

Only registry packs with the profile's own module counts go through the cache. Tiny test
packs, ``module_counts_override`` and ``host_acceptance`` builds call ``build_dataset``.

The three owned fixture builders bypass their caches whenever ``MUTANT_UNDER_TEST`` is
present, checked at each call. Returning to normal mode keeps the existing warm caches.
"""

from __future__ import annotations

import copy
import os
from datetime import date
from functools import cache, wraps

from operations.sample.blueprint import SampleDataset
from operations.sample.packs.registry import get_pack, pack_keys
from operations.sample.packs.types import SampleProfile
from operations.sample.scenario import build_dataset

ANCHOR = date(2026, 9, 30)


def mutation_aware_cache(builder):
    """Cache an owned fixture builder except while the mutation marker is present."""

    cached = cache(builder)

    @wraps(builder)
    def wrapped(*args, **kwargs):
        if "MUTANT_UNDER_TEST" in os.environ:
            return builder(*args, **kwargs)
        return cached(*args, **kwargs)

    wrapped.cache_clear = cached.cache_clear
    return wrapped


def sample_dataset(
    profile: SampleProfile = "small",
    seed: int = 42,
    anchor: date = ANCHOR,
    pack: str = "harbor",
) -> SampleDataset:
    """Return a private copy of ``build_dataset(profile, seed, anchor, pack)``."""

    return private_copy(_built(profile, seed, anchor, pack))


@mutation_aware_cache
def _built(profile: SampleProfile, seed: int, anchor: date, pack: str) -> SampleDataset:
    return build_dataset(profile, seed=seed, anchor_date=anchor, organization=get_pack(pack))


def private_copy[T](value: T) -> T:
    """Deep-copy ``value`` and keep the registry packs it refers to shared."""

    packs = (get_pack(key) for key in pack_keys())
    return copy.deepcopy(value, {id(pack): pack for pack in packs})
