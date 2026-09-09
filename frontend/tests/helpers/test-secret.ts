import { randomBytes } from "node:crypto";

// Generated only for isolated test transports; never a reusable credential.
export function testSecret(): string {
  return randomBytes(24).toString("hex");
}
