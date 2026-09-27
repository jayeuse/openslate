import { expect, test } from "@playwright/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BoardGrantsDisplay,
  emptyBoardGrantsState,
  grantRuleReference,
  revokeConfirmationText,
  transitionBoardGrantsState,
} from "../../src/components/systems/boards/components/server-backed-board-grants";

const boardId = "00000000-0000-4000-8000-000000000001";
const otherBoardId = "00000000-0000-4000-8000-000000000002";
const grantId = "00000000-0000-4000-8000-000000000003";

test("Board grant panel describes explicit rules separately from effective access", () => {
  const html = renderToStaticMarkup(
    createElement(BoardGrantsDisplay, {
      grants: [
        {
          id: grantId,
          principalType: "everyone",
          principalUserId: null,
          principalLabel: "Everyone",
          principalAvailable: true,
          permission: "view",
          effect: "deny",
          createdAt: "2026-09-23T00:00:00Z",
          updatedAt: "2026-09-23T00:00:00Z",
        },
      ],
      total: 1,
      pending: false,
      canMutate: true,
    }),
  );
  expect(html).toContain("Everyone");
  expect(html).toContain("Deny");
  expect(html).toContain("View");
  expect(html).toContain("explicit rules");
  expect(html).toContain("Preview Board access");
  expect(html).not.toContain(grantId);
  expect(html).toContain("Revoke");
  expect(html).toContain(`Rule ${grantId.slice(-8)}`);
});

test("unavailable principal names stay generic and otherwise identical revoke actions have distinct rule references", () => {
  const otherGrantId = "00000000-0000-4000-8000-000000000004";
  const grant = {
    id: grantId,
    principalType: "user" as const,
    principalUserId: "00000000-0000-4000-8000-000000000005",
    principalLabel: "Unavailable user",
    principalAvailable: false,
    permission: "view" as const,
    effect: "deny" as const,
    createdAt: "2026-09-23T00:00:00Z",
    updatedAt: "2026-09-23T00:00:00Z",
  };
  const grants = [grant, { ...grant, id: otherGrantId }];
  const html = renderToStaticMarkup(
    createElement(BoardGrantsDisplay, {
      grants,
      total: 2,
      pending: false,
      canMutate: true,
    }),
  );
  expect(html).toContain("Unavailable user");
  expect(html).not.toContain(grant.principalUserId);
  expect(grantRuleReference(grant, grants)).not.toBe(
    grantRuleReference(grants[1], grants),
  );
  expect(revokeConfirmationText(grant, grants)).toContain(
    grantRuleReference(grant, grants),
  );
  for (const rule of grants)
    expect(html).toContain(
      `aria-label="Revoke deny view Person: Unavailable user ${grantRuleReference(rule, grants)}"`,
    );
  expect(
    html.match(/Revoke deny view Person: Unavailable user Rule/g),
  ).toHaveLength(2);
});

test("active principal labels render as text, not executable markup or principal IDs", () => {
  const principalUserId = "00000000-0000-4000-8000-000000000005";
  const html = renderToStaticMarkup(
    createElement(BoardGrantsDisplay, {
      grants: [
        {
          id: grantId,
          principalType: "user",
          principalUserId,
          principalLabel: "Avery <script>unsafe</script>",
          principalAvailable: true,
          permission: "view",
          effect: "allow",
          createdAt: "2026-09-23T00:00:00Z",
          updatedAt: "2026-09-23T00:00:00Z",
        },
      ],
      total: 1,
      pending: false,
      canMutate: true,
    }),
  );
  expect(html).toContain("Avery &lt;script&gt;unsafe&lt;/script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain(principalUserId);
});

test("Board grant data clears on Board switch and denied refresh, ignoring stale completions", () => {
  const ready = transitionBoardGrantsState(
    transitionBoardGrantsState(emptyBoardGrantsState, {
      type: "begin",
      key: boardId,
      sequence: 1,
    }),
    {
      type: "resolve",
      key: boardId,
      sequence: 1,
      page: {
        items: [],
        pagination: {
          limit: 25,
          offset: 0,
          count: 0,
          total: 0,
          hasMore: false,
        },
        boardRevision: 4,
      },
    },
  );
  const switched = transitionBoardGrantsState(ready, {
    type: "begin",
    key: otherBoardId,
    sequence: 2,
  });
  expect(switched.page).toBeNull();
  expect(
    transitionBoardGrantsState(switched, {
      type: "resolve",
      key: boardId,
      sequence: 1,
      page: ready.page!,
    }),
  ).toEqual(switched);
  const denied = transitionBoardGrantsState(ready, {
    type: "reject",
    key: boardId,
    sequence: 1,
    error: "Board grant access is unavailable.",
  });
  expect(denied.page).toBeNull();
});
