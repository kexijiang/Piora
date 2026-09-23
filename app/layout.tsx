import { brandText } from "@/lib/branding";
import type { Metadata, Viewport } from "next";
import { BackgroundBootstrap } from "@/components/BackgroundBootstrap";
import { ApplicationRestoreGate } from "@/components/ApplicationRestoreGate";
import { AppTooltip } from "@/components/AppTooltip";
import { PwaRegistration } from "@/components/PwaRegistration";
import { BACKGROUND_INITIALIZATION_SCRIPT } from "@/lib/backgrounds";
import { FONT_PREFERENCE_INITIALIZATION_SCRIPT } from "@/lib/font-preferences";
import { THEME_INITIALIZATION_SCRIPT } from "@/lib/theme-preferences";
import { INTERFACE_TRANSPARENCY_INITIALIZATION_SCRIPT } from "@/lib/interface-transparency";
import "katex/dist/katex.min.css";
import "./globals.css";
import "./theme-backgrounds.css";
// Keep the lazy file workspace's styles in the route stylesheet. Its Webpack
// chunk can otherwise lose its CSS during a long desktop hot-reload session.
import "@/components/workspace/WorkspacePanel.module.css";
import "@/components/TabBar.module.css";
import "@/components/FileExplorer.module.css";
import "@/components/FileEditor.module.css";
import "@/components/FileCodeEditor.css";

const surfaceInitializationScript = `(function(){try{if(location.pathname==="/desktop-pet"||location.pathname==="/desktop-companion-bubble"){var r=document.documentElement;r.classList.add("desktop-pet-document");r.style.setProperty("color-scheme","light","important");r.style.setProperty("background","transparent","important")}}catch(_){}})();`;

export const metadata: Metadata = {
  title: brandText("Piora"),
  description: "Local-first desktop GUI for the Pi coding agent",
  applicationName: brandText("Piora"),
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      {
        url: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
    ],
    apple: [
      {
        url: "/icons/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: brandText("Piora"),
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1a1a" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" translate="no" className="notranslate" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: INTERFACE_TRANSPARENCY_INITIALIZATION_SCRIPT }} />
        <meta name="google" content="notranslate" />
        <script
          dangerouslySetInnerHTML={{
            __html: THEME_INITIALIZATION_SCRIPT,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: FONT_PREFERENCE_INITIALIZATION_SCRIPT,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: surfaceInitializationScript,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: BACKGROUND_INITIALIZATION_SCRIPT,
          }}
        />
      </head>
      <body translate="no" className="notranslate" style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
        <ApplicationRestoreGate><BackgroundBootstrap />
        {children}
        <AppTooltip />
        <PwaRegistration /></ApplicationRestoreGate>
      </body>
    </html>
  );
}
