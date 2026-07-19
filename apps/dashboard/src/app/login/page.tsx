import { getServerBackendBaseUrl } from "@/lib/config.server"
import { LoginPage } from "./login-form"

export default async function LoginPageServer() {
  let noUsers = false
  try {
    const backendUrl = getServerBackendBaseUrl()
    const res = await fetch(`${backendUrl}/auth/has-users`, {
      cache: "no-store",
    })
    if (res.ok) {
      const data = await res.json()
      if (data.has_users === false) {
        noUsers = true
      }
    }
  } catch {
    // Backend unreachable — show login form anyway (graceful degradation)
  }

  return <LoginPage noUsers={noUsers} />
}
