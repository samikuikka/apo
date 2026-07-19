import NextAuth from "next-auth"
import Credentials from "next-auth/providers/credentials"
import { getServerBackendBaseUrl } from "@/lib/config.server"

const isHttps = (process.env.NEXTAUTH_URL ?? "http://localhost:3000").startsWith("https://")
const authSecret =
  process.env.AUTH_SECRET ||
  (process.env.NODE_ENV === "production" ? undefined : "dev-insecure-auth-secret")

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials) => {
        const backendUrl = getServerBackendBaseUrl()

        try {
          const res = await fetch(`${backendUrl}/auth/verify-password`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              email: credentials.email,
              password: credentials.password,
            }),
          })

          if (!res.ok) return null

          const user = await res.json()
          return {
            id: user.id,
            email: user.email,
            name: user.name,
            is_admin: user.is_admin,
          }
        } catch {
          return null
        }
      },
    }),
  ],
  secret: authSecret,
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  cookies: {
    sessionToken: {
      name: isHttps ? "__Secure-authjs.session-token" : "authjs.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: isHttps,
      },
    },
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id
        token.email = user.email
        token.name = user.name
        token.is_admin = user.is_admin
      }
      return token
    },
    async session({ session, token }) {
      session.user.id = token.id as string
      session.user.is_admin = token.is_admin as boolean
      return session
    },
  },
})
