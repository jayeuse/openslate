import { CSPProvider } from "@base-ui/react/csp-provider";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
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

export const metadata: Metadata = {
  title: {
    default: "OpenSlate Operations",
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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        <script src="/theme-init.js" />
      </head>
      <body className="flex min-h-full flex-col">
        <ThemeProvider />
        <CSPProvider disableStyleElements>{children}</CSPProvider>
      </body>
    </html>
  );
}
