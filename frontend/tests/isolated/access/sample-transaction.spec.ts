import { expect, test } from "@playwright/test";
import { applySampleTransaction } from "../../../src/components/systems/shared/runtime/sample-state";

test("a sample transaction updates multiple keys without mutating its input", () => {
  const previous = {
    roles: [{ id: "member", name: "Member" }],
    boards: [{ id: "dispatch", roleNames: ["Member"] }],
    untouched: { enabled: true },
  };

  const next = applySampleTransaction(previous, ({ update }) => {
    update("roles", [], (roles: { id: string; name: string }[]) =>
      roles.map((role) => ({ ...role, name: "Operator" })),
    );
    update("boards", [], (boards: { id: string; roleNames: string[] }[]) =>
      boards.map((board) => ({ ...board, roleNames: ["Operator"] })),
    );
  });

  expect(next).toEqual({
    roles: [{ id: "member", name: "Operator" }],
    boards: [{ id: "dispatch", roleNames: ["Operator"] }],
    untouched: { enabled: true },
  });
  expect(previous.roles[0].name).toBe("Member");
  expect(previous.boards[0].roleNames).toEqual(["Member"]);
  expect(next.untouched).toBe(previous.untouched);
});

test("transaction updates decode incompatible stored values and compose in order", () => {
  const next = applySampleTransaction(
    { sessions: ["legacy string session"] },
    ({ update }) => {
      update("sessions", [{ id: "current", current: true }], (sessions) => [
        ...sessions,
        { id: "remote", current: false },
      ]);
      update("sessions", [{ id: "current", current: true }], (sessions) =>
        sessions.filter((session) => session.id !== "remote"),
      );
    },
  );

  expect(next.sessions).toEqual([{ id: "current", current: true }]);
});
