import { content as minimap } from "@antv/x6/es/plugin/minimap/style/raw";
import { content as selection } from "@antv/x6/es/plugin/selection/style/raw";
import { content as snapline } from "@antv/x6/es/plugin/snapline/style/raw";
import { content as core } from "@antv/x6/es/style/raw";

// X6 and its Selection, Snapline and MiniMap plugins insert these exact
// stylesheets as inline <style> elements at runtime, and the plugins do so
// even with Config.autoInsertCSS off. The production CSP only admits inline
// styles whose hash appears in the exported HTML (backend StaticSite). The
// root layout renders the same text in <head>, because the signed-in pages
// render only on the client and their markup is not in the HTML; the runtime
// copies then match an allowed hash instead of being blocked. Keep this list
// equal to the plugins that sandbox-canvas-runtime.ts uses.
const X6_STYLESHEETS = [
  ["core", core],
  ["selection", selection],
  ["snapline", snapline],
  ["minimap", minimap],
] as const;

export function X6Stylesheets() {
  return X6_STYLESHEETS.map(([name, css]) => (
    <style key={name} dangerouslySetInnerHTML={{ __html: css }} />
  ));
}
