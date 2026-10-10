type ActionLocation = Pick<Location, "hash" | "pathname" | "search">;
type ActionHistory = Pick<History, "replaceState">;

export function consumeActionToken(
  location: ActionLocation,
  history: ActionHistory,
  expectedType: "invite" | "recovery" | "email_change",
): string | null {
  const fragment = location.hash;
  if (fragment || location.search) {
    // A one-time action credential must not remain in history, even when malformed.
    history.replaceState(null, "", location.pathname);
  }
  if (!fragment.startsWith("#")) return null;
  const rawFields = fragment.slice(1).split("&");
  if (rawFields.length !== 2) return null;
  try {
    for (const field of rawFields) {
      if (!field.includes("=")) return null;
      decodeURIComponent(field.replaceAll("+", " "));
    }
  } catch {
    return null;
  }
  const parameters = new URLSearchParams(fragment.slice(1));
  if (
    parameters.getAll("token_hash").length !== 1 ||
    parameters.getAll("type").length !== 1 ||
    parameters.get("type") !== expectedType
  )
    return null;
  const token = parameters.get("token_hash");
  if (!token || token !== token.trim() || /\s|[\x00-\x1f\x7f]/u.test(token))
    return null;
  if (expectedType === "email_change" && !/^[0-9a-f]{56}$/.test(token))
    return null;
  return token;
}
