import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "apo - Example Service",
  description: "Example chat endpoint with agent tool-calling",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
