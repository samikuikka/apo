import { auth } from "@/auth"
import { NextResponse } from "next/server"
import { getSafeRedirectPath } from "@/lib/redirect"

export default auth((req) => {
  const authDisabled =
    process.env.NODE_ENV !== "production" &&
    process.env.NEXT_PUBLIC_AUTH_DISABLED === "true"
  const { pathname } = req.nextUrl

  // /backend-proxy is a pass-through to the FastAPI backend. The backend
  // enforces its own auth, so gating it here only breaks unauthenticated
  // API calls (setup, login, forgot-password, invitation preview) that go
  // through the same-origin proxy to avoid CORS.
  const publicPaths = ["/login", "/setup", "/public", "/api/auth", "/forgot-password", "/reset-password", "/accept-invitation", "/backend-proxy"]
  const isPublic = publicPaths.some((p) => pathname.startsWith(p))

  if (isPublic) return NextResponse.next()

  if (authDisabled) return NextResponse.next()

  if (!req.auth) {
    const loginUrl = new URL("/login", req.url)
    loginUrl.searchParams.set("callbackUrl", getSafeRedirectPath(pathname))
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
})

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|brand).*)",
  ],
}
