type InvitationLocation = Pick<Location, "hash" | "pathname" | "search">;
type InvitationHistory = Pick<History, "replaceState">;

export function consumeInvitationToken(
  location: InvitationLocation,
  history: InvitationHistory,
): string | null {
  if (!location.hash.startsWith("#")) return null;
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  if (!token) return null;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  return token;
}

export function retainInvitationToken(
  current: string | null,
  captured: string | null,
): string | null {
  return current ?? captured;
}
