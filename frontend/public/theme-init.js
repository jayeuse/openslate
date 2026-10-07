try {
  const browserCrypto = globalThis.crypto;
  if (
    typeof browserCrypto?.randomUUID !== "function" &&
    typeof browserCrypto?.getRandomValues === "function"
  ) {
    Object.defineProperty(browserCrypto, "randomUUID", {
      configurable: true,
      value: () => {
        const bytes = new Uint8Array(16);
        browserCrypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      },
      writable: true,
    });
  }
} catch {}

try {
  const root = document.documentElement;
  const preference = (key, fallback, values) => {
    try {
      const value = localStorage.getItem(key);
      return values.includes(value) ? value : fallback;
    } catch {
      return fallback;
    }
  };
  const mode = preference("openslate-theme", "system", [
    "light",
    "dark",
    "system",
  ]);
  root.classList.toggle(
    "dark",
    mode === "dark" ||
      (mode === "system" &&
        typeof matchMedia === "function" &&
        matchMedia("(prefers-color-scheme: dark)").matches),
  );
  if (preference("openslate-motion", "system", ["reduced"]) === "reduced")
    root.dataset.motion = "reduced";
  else delete root.dataset.motion;
  root.dataset.textSize = preference("openslate-text-size", "100", [
    "100",
    "112.5",
    "125",
  ]);
  root.dataset.density = preference("openslate-density", "default", [
    "default",
    "compact",
    "spacious",
  ]);
  const theme = preference("openslate-org-theme", "slate", [
    "slate",
    "whiteboard",
    "triplicate",
    "stockroom",
  ]);
  if (theme !== "slate") root.dataset.theme = theme;
} catch {}
