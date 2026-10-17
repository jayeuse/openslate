"""Every join through memberships names an organization.

``memberships`` has no row-level security (account reads list a person's memberships
across organizations), so a join through it without an organization condition matches
people of every organization. Use ``bound_membership_join()``, or name ``org_id`` or the
bound organization within the statement.
"""

import re
from pathlib import Path

APP = Path(__file__).resolve().parents[2] / "app"
UNSCOPED_JOIN = re.compile(
    r"join\(\s*Membership,\s*Membership\.user_id\s*==\s*User\.id\s*\)"
    r"|join\(\s*User,\s*User\.id\s*==\s*Membership\.user_id\s*\)"
)
# The organization condition must appear within this many following lines.
WINDOW = 8


def test_every_membership_join_names_an_organization() -> None:
    unscoped = []
    for path in sorted(APP.rglob("*.py")):
        lines = path.read_text().splitlines()
        for index, line in enumerate(lines):
            if not UNSCOPED_JOIN.search(line):
                continue
            nearby = "\n".join(lines[index:index + WINDOW])
            if not re.search(r"org_id|bound_organization", nearby):
                unscoped.append(f"{path.relative_to(APP.parent)}:{index + 1}")
    assert unscoped == [], "Join memberships with bound_membership_join(): " + ", ".join(unscoped)
