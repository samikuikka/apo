import type { Metadata } from "next";

// "use client" pages can't export metadata directly; a Server Component
// layout is the idiomatic place to declare the tab title.
export const metadata: Metadata = { title: "Sign in" };

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
