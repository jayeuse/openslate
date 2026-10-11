import { CSPProvider } from "@base-ui/react/csp-provider";
import { Toaster } from "@/components/ui/toast";
import type { Metadata } from "next";
import {
  Archivo,
  Atkinson_Hyperlegible_Next,
  Big_Shoulders_Stencil,
  Geist,
  Geist_Mono,
  Martian_Mono,
  Schibsted_Grotesk,
} from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { OrganizationThemeProvider } from "@/components/organization-theme-provider";
import { X6Stylesheets } from "@/components/sandbox/x6-stylesheets";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  preload: false,
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  preload: false,
});

// Slate's display face: headings, page titles, and department names.
// Preloaded because Slate is the default look and every page has a title,
// so the title never swaps face after the first paint.
const schibstedGrotesk = Schibsted_Grotesk({
  variable: "--font-schibsted",
  subsets: ["latin"],
  weight: ["700", "800"],
});

// Organization themes (src/app/themes). Without preload, a browser fetches a
// face only when rendered text uses it, so Slate pages load none of these.
// next/font has no fallback metrics for Atkinson Hyperlegible Next or Big
// Shoulders Stencil, and the dev server warns on every compile when it looks
// them up. An explicit fallback list skips that lookup; it matches the stacks
// the Whiteboard and Stockroom looks already put after these faces.
const atkinson = Atkinson_Hyperlegible_Next({
  variable: "--font-atkinson",
  subsets: ["latin"],
  preload: false,
  fallback: ["system-ui", "sans-serif"],
});

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  axes: ["wdth"],
  preload: false,
});

const bigShouldersStencil = Big_Shoulders_Stencil({
  variable: "--font-stencil",
  subsets: ["latin"],
  preload: false,
  fallback: ["sans-serif"],
});

const martianMono = Martian_Mono({
  variable: "--font-martian-mono",
  subsets: ["latin"],
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
      className={`${geistSans.variable} ${geistMono.variable} ${schibstedGrotesk.variable} ${atkinson.variable} ${archivo.variable} ${martianMono.variable} ${bigShouldersStencil.variable} h-full antialiased`}
    >
      <head>
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/theme-init.js" />
        <X6Stylesheets />
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
