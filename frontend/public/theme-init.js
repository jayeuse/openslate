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
    const value = localStorage.getItem(key);
    return values.includes(value) ? value : fallback;
  };
  const mode = preference("openslate-theme", "light", ["light", "dark"]);
  root.classList.toggle("dark", mode === "dark");
  // Organization look (lib/appearance-preferences.ts). Slate is the default.
  const theme = preference("openslate-org-theme", "slate", [
    "slate",
    "whiteboard",
    "triplicate",
    "stockroom",
  ]);
  if (theme !== "slate") root.dataset.theme = theme;
} catch {}
