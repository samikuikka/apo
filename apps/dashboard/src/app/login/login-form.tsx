"use client"

import { Suspense, useEffect, useReducer } from "react"
import { signIn } from "next-auth/react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { ArrowRight, Loader2, MailWarning } from "lucide-react"
import AuthShell from "@/components/auth/auth-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { backendFetch } from "@/lib/backend-fetch"
import { getSafeRedirectPath } from "@/lib/redirect"

export function LoginPage({ noUsers }: { noUsers: boolean }) {
  return (
    <Suspense>
      <LoginForm noUsers={noUsers} />
    </Suspense>
  )
}

function VerifyPrompt({
  email,
  resendInfo,
  error,
  retryAfter,
  resending,
  onResend,
  onBack,
}: {
  email: string
  resendInfo: string | null
  error: string | null
  retryAfter: number
  resending: boolean
  onResend: () => void
  onBack: () => void
}) {
  return (
    <AuthShell>
      <div className="space-y-4">
        <div className="flex items-start gap-2 border border-warning bg-warning/10 px-3 py-2 text-xs text-warning">
          <MailWarning className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            The account <strong>{email}</strong> has not been verified yet.
            Please check your email for a 6-digit verification code.
          </span>
        </div>

        {resendInfo && (
          <p className="border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            {resendInfo}
          </p>
        )}

        {error && (
          <p className="border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}

        <Link href={`/verify-email?email=${encodeURIComponent(email)}`}>
          <Button type="button" className="group h-10 w-full">
            Enter verification code
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Button>
        </Link>

        <button
          type="button"
          onClick={onResend}
          disabled={resending || retryAfter > 0}
          className="w-full text-center text-xs text-muted-foreground underline underline-offset-4 transition-opacity hover:opacity-80 disabled:opacity-50"
        >
          {resending ? "Sending..." : retryAfter > 0 ? `Resend available in ${retryAfter}s` : "Resend verification code"}
        </button>

        <button
          type="button"
          onClick={onBack}
          className="w-full text-center text-xs text-muted-foreground underline underline-offset-4 transition-opacity hover:opacity-80"
        >
          Back to login
        </button>
      </div>
    </AuthShell>
  )
}

function LoginCredentialsForm({
  email,
  password,
  onEmailChange,
  onPasswordChange,
  onSubmit,
  error,
  retryAfter,
  successMessage,
  loading,
  noUsers,
}: {
  email: string
  password: string
  onEmailChange: (value: string) => void
  onPasswordChange: (value: string) => void
  onSubmit: (e: React.FormEvent) => void
  error: string | null
  retryAfter: number
  successMessage: string | null
  loading: boolean
  noUsers: boolean
}) {
  return (
    <AuthShell>
      <form onSubmit={onSubmit} className="space-y-4">
        {noUsers && (
          <div className="border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            No accounts exist yet.{" "}
            <Link
              href="/setup"
              className="text-foreground underline underline-offset-4 hover:opacity-80"
            >
              Set up the first admin account
            </Link>{" "}
            to get started.
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="email" className="text-xs text-muted-foreground">
            Email
          </Label>
          <Input
            id="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            className="h-10 bg-input/50 ring-1 ring-white/10"
            autoFocus
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password" className="text-xs text-muted-foreground">
            Password
          </Label>
          <Input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            placeholder="••••••••••••"
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            className="h-10 bg-input/50 ring-1 ring-white/10"
          />
          <div className="flex justify-end">
            <Link
              href="/forgot-password"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Forgot password?
            </Link>
          </div>
        </div>

        {error && (
          <p className="border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
            {retryAfter > 0 && (
              <span className="ml-1 tabular-nums">
                ({Math.floor(retryAfter / 60)}:{String(retryAfter % 60).padStart(2, "0")} remaining)
              </span>
            )}
          </p>
        )}

        {successMessage && (
          <p className="border border-success bg-success/10 px-3 py-2 text-xs text-success">
            {successMessage}
          </p>
        )}

        <Button
          type="submit"
          disabled={loading || retryAfter > 0}
          className="group h-10 w-full"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Verifying
            </>
          ) : (
            <>
              Sign in
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </>
          )}
        </Button>

        <p className="text-center text-xs text-muted-foreground">
          Need an account?{" "}
          <Link
            href="/setup"
            className="text-foreground underline underline-offset-4 transition-opacity hover:opacity-80"
          >
            Create account
          </Link>
        </p>
      </form>
    </AuthShell>
  )
}

interface LoginState {
  email: string
  password: string
  error: string | null
  loading: boolean
  retryAfter: number
  showVerifyPrompt: boolean
  resending: boolean
  resendInfo: string | null
}

type LoginAction =
  | { type: "SET_FIELD"; field: "email" | "password"; value: string }
  | { type: "SUBMIT_START" }
  | { type: "SUBMIT_ERROR"; error: string }
  | { type: "SHOW_VERIFY" }
  | { type: "RESEND_START" }
  | { type: "RESEND_SUCCESS"; info: string }
  | { type: "SET_ERROR"; error: string }
  | { type: "SET_RETRY"; seconds: number }
  | { type: "TICK_RETRY" }
  | { type: "CLEAR_LOADING" }
  | { type: "CLEAR_RESENDING" }
  | { type: "RESET_VERIFY" }

const initialLoginState: LoginState = {
  email: "",
  password: "",
  error: null,
  loading: false,
  retryAfter: 0,
  showVerifyPrompt: false,
  resending: false,
  resendInfo: null,
}

function loginReducer(state: LoginState, action: LoginAction): LoginState {
  switch (action.type) {
    case "SET_FIELD":
      return { ...state, [action.field]: action.value }
    case "SUBMIT_START":
      return {
        ...state,
        error: null,
        retryAfter: 0,
        showVerifyPrompt: false,
        resendInfo: null,
        loading: true,
      }
    case "SUBMIT_ERROR":
      return { ...state, error: action.error, loading: false }
    case "SHOW_VERIFY":
      return { ...state, showVerifyPrompt: true, loading: false }
    case "RESEND_START":
      return { ...state, resendInfo: null, error: null, resending: true }
    case "RESEND_SUCCESS":
      return { ...state, resendInfo: action.info, resending: false }
    case "SET_ERROR":
      return { ...state, error: action.error }
    case "SET_RETRY":
      return { ...state, retryAfter: action.seconds }
    case "TICK_RETRY":
      return { ...state, retryAfter: state.retryAfter <= 1 ? 0 : state.retryAfter - 1 }
    case "CLEAR_LOADING":
      return { ...state, loading: false }
    case "CLEAR_RESENDING":
      return { ...state, resending: false }
    case "RESET_VERIFY":
      return {
        ...state,
        showVerifyPrompt: false,
        error: null,
        resendInfo: null,
        retryAfter: 0,
      }
    default:
      return state
  }
}

function LoginForm({ noUsers }: { noUsers: boolean }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const callbackUrl = getSafeRedirectPath(searchParams.get("callbackUrl"))

  const [state, dispatch] = useReducer(loginReducer, initialLoginState)
  const { email, password, error, loading, retryAfter, showVerifyPrompt, resending, resendInfo } = state

  useEffect(() => {
    if (retryAfter <= 0) return
    const timer = setInterval(() => {
      dispatch({ type: "TICK_RETRY" })
    }, 1000)
    return () => clearInterval(timer)
  }, [retryAfter])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    dispatch({ type: "SUBMIT_START" })

    try {
      const res = await backendFetch("/auth/verify-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      })

      if (res.status === 429) {
        const retryAfterHeader = res.headers.get("Retry-After")
        const seconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 300
        dispatch({ type: "SET_RETRY", seconds })
        const minutes = Math.ceil(seconds / 60)
        dispatch({ type: "SUBMIT_ERROR", error: `Too many attempts. Try again in ${minutes} minute${minutes !== 1 ? "s" : ""}.` })
        return
      }

      if (res.status === 403) {
        const data = await res.json().catch(() => null)
        const detail = data?.detail
        if (detail && typeof detail === "object" && detail.code === "EMAIL_NOT_VERIFIED") {
          dispatch({ type: "SHOW_VERIFY" })
          return
        }
      }

      if (!res.ok) {
        dispatch({ type: "SUBMIT_ERROR", error: "Invalid email or password" })
        return
      }

      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
        redirectTo: callbackUrl,
      })
      if (result?.error) {
        dispatch({ type: "SUBMIT_ERROR", error: "Sign-in failed. Please try again." })
        return
      }
      router.push(result?.url ?? callbackUrl)
    } catch {
      dispatch({ type: "SUBMIT_ERROR", error: "Unable to connect to server" })
    } finally {
      dispatch({ type: "CLEAR_LOADING" })
    }
  }

  async function handleResend() {
    dispatch({ type: "RESEND_START" })

    try {
      const res = await backendFetch("/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      })

      if (res.status === 429) {
        const retryAfterHeader = res.headers.get("Retry-After")
        const seconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 60
        dispatch({ type: "SET_RETRY", seconds })
        dispatch({ type: "SET_ERROR", error: `Please wait ${seconds}s before requesting a new code.` })
        return
      }

      dispatch({
        type: "RESEND_SUCCESS",
        info: "If an account exists and is unverified, a new code has been sent. Check your email and enter the code on the verify page.",
      })
    } catch {
      dispatch({ type: "SET_ERROR", error: "Unable to connect to server" })
    } finally {
      dispatch({ type: "CLEAR_RESENDING" })
    }
  }

  // Derived directly from the URL param — no effect/state needed since the
  // success message is never mutated by any other handler on this page.
  const successMessage =
    searchParams.get("reset") === "success"
      ? "Password reset successfully. Please sign in with your new password."
      : null

  if (showVerifyPrompt) {
    return (
      <VerifyPrompt
        email={email}
        resendInfo={resendInfo}
        error={error}
        retryAfter={retryAfter}
        resending={resending}
        onResend={handleResend}
        onBack={() => dispatch({ type: "RESET_VERIFY" })}
      />
    )
  }

  return (
    <LoginCredentialsForm
      email={email}
      password={password}
      onEmailChange={(value) => dispatch({ type: "SET_FIELD", field: "email", value })}
      onPasswordChange={(value) => dispatch({ type: "SET_FIELD", field: "password", value })}
      onSubmit={handleSubmit}
      error={error}
      retryAfter={retryAfter}
      successMessage={successMessage}
      loading={loading}
      noUsers={noUsers}
    />
  )
}
