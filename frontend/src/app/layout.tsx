import { CSPProvider } from "@base-ui/react/csp-provider";
import { Toaster } from "@/components/ui/toast";
import type { Metadata } from "next";
import localFont from "next/font/local";
import { ThemeProvider } from "@/components/theme-provider";
import { OrganizationThemeProvider } from "@/components/organization-theme-provider";
import "./globals.css";

// Fonts are self-hosted from src/app/fonts so a build never downloads them.
// next/font/local names each @font-face family after its constant, so the
// constants carry the font names that devtools and theme tests show.
// Each file holds every subset Google served (Latin, Latin Extended, and
// Vietnamese or Cyrillic where the family has them); see fonts/README.md.
const Geist = localFont({
  src: "./fonts/Geist-Variable.woff2",
  weight: "100 900",
  variable: "--font-geist-sans",
  preload: false,
});

const GeistMono = localFont({
  src: "./fonts/GeistMono-Variable.woff2",
  weight: "100 900",
  variable: "--font-geist-mono",
  preload: false,
});

// Slate's display face: headings, page titles, and department names.
// Preloaded because Slate is the default look and every page has a title,
// so the title never swaps face after the first paint. The file and range
// hold only 700 to 800: lighter requests (titles ask for 600) render at 700.
const SchibstedGrotesk = localFont({
  src: "./fonts/SchibstedGrotesk-Variable.woff2",
  weight: "700 800",
  variable: "--font-schibsted",
});

// Organization themes (src/app/themes). Without preload, a browser fetches a
// face only when rendered text uses it, so Slate pages load none of these.
// Atkinson and the stencil face skip the generated metric fallback (as
// next/font/google had none for them); their explicit fallback lists match
// the stacks the Whiteboard and Stockroom looks already put after these faces.
const AtkinsonHyperlegibleNext = localFont({
  src: "./fonts/AtkinsonHyperlegibleNext-Variable.woff2",
  weight: "200 800",
  variable: "--font-atkinson",
  preload: false,
  adjustFontFallback: false,
  fallback: ["system-ui", "sans-serif"],
});

const Archivo = localFont({
  src: "./fonts/Archivo-Variable.woff2",
  weight: "100 900",
  // Archivo keeps its width axis (62% to 125%).
  declarations: [{ prop: "font-stretch", value: "62% 125%" }],
  variable: "--font-archivo",
  preload: false,
});

const BigShouldersStencil = localFont({
  src: "./fonts/BigShouldersStencil-Variable.woff2",
  weight: "100 900",
  variable: "--font-stencil",
  preload: false,
  adjustFontFallback: false,
  fallback: ["sans-serif"],
});

const MartianMono = localFont({
  src: "./fonts/MartianMono-Variable.woff2",
  weight: "100 800",
  variable: "--font-martian-mono",
  preload: false,
});

export const metadata: Metadata = {
  title: {
    default: "OpenSlate",
    template: "%s | OpenSlate",
  },
  description: "A focused workspace for departments, modules, and records.",
};

export const dynamic = "error";

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      // The blocking external theme script mutates <html> (dark class +
      // data-* attributes) before hydration, so the DOM intentionally
      // differs from this render. Suppress the warning and keep React
      // from patching those attributes back.
      suppressHydrationWarning
      className={`${Geist.variable} ${GeistMono.variable} ${SchibstedGrotesk.variable} ${AtkinsonHyperlegibleNext.variable} ${Archivo.variable} ${MartianMono.variable} ${BigShouldersStencil.variable} h-full antialiased`}
    >
      <head>
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/theme-init.js" />
      </head>
      <body className="flex min-h-full flex-col">
        <ThemeProvider />
        <CSPProvider disableStyleElements>
          <OrganizationThemeProvider>
            {children}
            <Toaster />
          </OrganizationThemeProvider>
        </CSPProvider>
      </body>
    </html>
  );
}
