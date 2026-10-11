import type { Page } from "@playwright/test";

// The production CSP refuses inline <style> elements, so test-only CSS is served
// as a same-origin stylesheet instead of `addStyleTag({ content })`.
export async function addTestStylesheet(page: Page, name: string, css: string) {
  const path = `/__playwright__/${name}.css`;
  await page.route(`**${path}`, (route) =>
    route.fulfill({ contentType: "text/css", body: css }),
  );
  await page.addStyleTag({ url: path });
}

// Hides only the `next dev` error overlay; a production build has none.
export function hideDevOverlay(page: Page) {
  return addTestStylesheet(
    page,
    "hide-dev-overlay",
    "nextjs-portal { display: none !important; }",
  );
}
