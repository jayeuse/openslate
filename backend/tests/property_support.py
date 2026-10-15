"""One Hypothesis setting for every property test in the backend suite.

``derandomize`` makes each property draw the same examples on every run, so a local
run, CI and a mutation run see the same inputs. ``database=None`` keeps no example
store between runs. ``deadline=None``: the per-example deadline is a wall-clock limit,
and the 4-core development machine runs other lanes and the stack beside these tests;
a slow example is not a failure of the property.
"""

from hypothesis import settings

PROPERTY = settings(derandomize=True, database=None, deadline=None, max_examples=300)
