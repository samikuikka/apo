"use client"

import { Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { ArrowRight, CheckCircle2, Loader2 } from "lucide-react"
import AuthShell from "@/components/auth/auth-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { backendFetch } from "@/lib/backend-fetch"

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailForm />
    </Suspense>
  )
}

function VerifyEmailForm() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [email, setEmail] = useState("")
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [infoMessage, setInfoMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [resending, setResending] = useState(false)
  const [retryAfter, setRetryAfter] = useState(0)
  const [verified, setVerified] = useState(false)

  useEffect(() => {
    const emailParam = searchParams.get("email")
    if (emailParam) {
      setEmail(emailParam)
    }
  }, [searchParams])

  useEffect(() => {
    if (retryAfter <= 0) return
    const timer = setInterval(() => {
      setRetryAfter((prev) => {
        if (prev <= 1) return 0
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [retryAfter])

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setInfoMessage(null)
    setLoading(true)

    try {
      const res = await backendFetch("/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setError(data?.detail ?? "Invalid or expired code")
        return
      }

      setVerified(true)
    } catch {
      setError("Unable to connect to server")
    } finally {
      setLoading(false)
    }
  }

  async function handleResend() {
    setError(null)
    setInfoMessage(null)
    setResending(true)

    try {
      const res = await backendFetch("/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      })

      if (res.status === 429) {
        const retryAfterHeader = res.headers.get("Retry-After")
        const seconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 60
        setRetryAfter(seconds)
        setError(`Please wait ${seconds}s before requesting a new code.`)
        return
      }

      setInfoMessage("If an account exists and is unverified, a new code has been sent. Check your email.")
      setCode("")
    } catch {
      setError("Unable to connect to server")
    } finally {
      setResending(false)
    }
  }

  if (verified) {
    return (
      <AuthShell>
        <div className="space-y-4">
          <div className="flex items-center justify-center py-4">
            <div className="rounded-full bg-success/10 p-3">
              <CheckCircle2 className="h-8 w-8 text-success" />
            </div>
          </div>
          <p className="text-sm text-center text-muted-foreground">
            Your email has been verified. You can now sign in to your account.
          </p>
          <Button
            type="button"
            className="h-10 w-full"
            onClick={() => router.push("/login")}
          >
            Continue to login
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <form onSubmit={handleVerify} className="space-y-4">
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
            onChange={(e) => setEmail(e.target.value)}
            className="h-10 bg-input/50 ring-1 ring-white/10"
            autoFocus={!email}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="code" className="text-xs text-muted-foreground">
            Verification code
          </Label>
          <Input
            id="code"
            type="text"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            required
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="h-12 bg-card text-center text-[18px] tracking-[0.5em]"
            placeholder="000000"
            autoFocus={!!email}
          />
        </div>

        {infoMessage && (
          <p className="border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            {infoMessage}
          </p>
        )}

        {error && (
          <p className="border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
            {retryAfter > 0 && (
              <span className="ml-1 tabular-nums">({retryAfter}s remaining)</span>
            )}
          </p>
        )}

        <Button
          type="submit"
          disabled={loading || code.length !== 6 || email.length === 0}
          className="group h-10 w-full"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Verifying
            </>
          ) : (
            <>
              Verify email
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </>
          )}
        </Button>

        <button
          type="button"
          onClick={handleResend}
          disabled={resending || retryAfter > 0 || email.length === 0}
          className="w-full text-center text-xs text-muted-foreground underline underline-offset-4 transition-opacity hover:opacity-80 disabled:opacity-50"
        >
          {resending
            ? "Sending..."
            : retryAfter > 0
              ? `Resend available in ${retryAfter}s`
              : "Resend verification code"}
        </button>
      </form>
    </AuthShell>
  )
}
