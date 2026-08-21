export type Session = {
  accessToken: string;
  refreshToken: string;
  username?: string;
  roleId?: string;
};
const key = "openslate-session";

export function getSession(): Session | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}
export function setSession(session: Session) {
  window.sessionStorage.setItem(key, JSON.stringify(session));
}
export function clearSession() {
  if (typeof window !== "undefined") window.sessionStorage.removeItem(key);
}
