import { consumeActionToken } from "@/lib/action-token";

export function consumeRecoveryToken(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState">,
): string | null {
  return consumeActionToken(location, history, "recovery");
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
