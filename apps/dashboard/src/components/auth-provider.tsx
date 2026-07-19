"use client"

import { SessionProvider } from "next-auth/react"

export function AuthProvider({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider refetchOnWindowFocus refetchInterval={5 * 60}>
      {children}
    </SessionProvider>
  )
}
