import type { Metadata } from "next";
import { Noto_Sans } from "next/font/google";
import "./globals.css";
import { TopNav } from "@/components/top-nav";
import { AuthProvider } from "@/components/auth-provider";

const fontSans = Noto_Sans({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  // Each page declares its own title (e.g. "Runs", "Trace abc123") and the
  // "%s" template shows it verbatim — no "apo" suffix, since the suffix
  // adds no value in a browser tab. The root/landing page falls back to
  // "apo" below — it IS the app, so the bare name belongs there.
  title: { default: "apo", template: "%s" },
  description: "Observability and evaluation for agent tasks.",
  applicationName: "apo",
  icons: {
    icon: [
      // The 32px master is listed first so browsers preferring a sized
      // match get a pixel-crisp icon at the most common tab size. The
      // 512px master covers Apple touch icons and any larger requests.
      {
        url: "/brand/signal-sphere-favicon-32.png",
        sizes: "32x32",
        type: "image/png",
      },
      {
        url: "/brand/signal-sphere-favicon.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
    apple: [
      {
        url: "/brand/signal-sphere-favicon.png",
        sizes: "512x512",
      },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`dark ${fontSans.variable}`}>
      <body className="antialiased">
        <AuthProvider>
          <TopNav />
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
