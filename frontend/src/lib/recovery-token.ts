type RecoveryLocation = Pick<Location, "hash" | "pathname" | "search">;
type RecoveryHistory = Pick<History, "replaceState">;

export function consumeRecoveryToken(
  location: RecoveryLocation,
  history: RecoveryHistory,
): string | null {
  if (!location.hash.startsWith("#")) return null;
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  if (!token) return null;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  return token;
}

export function retainRecoveryToken(
  current: string | null,
  captured: string | null,
): string | null {
  return current ?? captured;
}

export function passwordsMatch(
  password: string,
  confirmation: string,
): boolean {
  return password === confirmation;
}

export function hasValidRecoveryPasswordLength(password: string): boolean {
  return password.length >= 12 && password.length <= 128;
}
