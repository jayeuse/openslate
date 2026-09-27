import { consumeActionToken } from "@/lib/action-token";

export function consumeInvitationToken(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState">,
): string | null {
  return consumeActionToken(location, history, "invite");
}

export function retainInvitationToken(
  current: string | null,
  captured: string | null,
): string | null {
  return current ?? captured;
}
