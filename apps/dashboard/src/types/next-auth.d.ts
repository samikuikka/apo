import "next-auth"
import type { DefaultSession } from "next-auth"

declare module "next-auth" {
  interface User {
    id: string
    email: string
    name: string
    is_admin: boolean
  }

  interface Session extends DefaultSession {
    user: {
      id: string
      email: string
      name: string
      is_admin: boolean
    } & DefaultSession["user"]
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    id: string
    email: string
    name: string
    is_admin: boolean
  }
}
