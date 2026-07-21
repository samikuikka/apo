"use client"

import Link from "next/link"
import { useState } from "react"
import { signIn } from "next-auth/react"
import { useRouter } from "next/navigation"
import { ArrowRight, Loader2, MailCheck } from "lucide-react"
import AuthShell from "@/components/auth/auth-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { backendFetch } from "@/lib/backend-fetch"

function validatePassword(password: string) {
  return {
    minLength: password.length >= 8,
    hasLetter: /[a-zA-Z]/.test(password),
    hasNumber: /\d/.test(password),
  }
}

const PASSWORD_RULES = [
  { id: "min-length", label: "At least 8 characters" },
  { id: "has-letter", label: "At least one letter" },
  { id: "has-number", label: "At least one number" },
] as const

function PasswordRules({ password }: { password: string }) {
  if (password.length === 0) return null
  const checks = validatePassword(password)
  return (
    <ul className="space-y-1 text-xs text-muted-foreground">
      {PASSWORD_RULES.map((rule) => {
        const passed =
          rule.id === "min-length"
            ? checks.minLength
            : rule.id === "has-letter"
              ? checks.hasLetter
              : checks.hasNumber

        return (
          <li
            key={rule.id}
            className={passed ? "text-success" : "text-muted-foreground"}
          >
            {passed ? "✓" : "○"} {rule.label}
          </li>
        )
      })}
    </ul>
  )
}

function OtpStep({
  otpCode,
  onOtpCodeChange,
  infoMessage,
  error,
  loading,
  onSubmit,
  onResend,
  onBackToForm,
}: {
  otpCode: string
  onOtpCodeChange: (value: string) => void
  infoMessage: string | null
  error: string | null
  loading: boolean
  onSubmit: (e: React.FormEvent) => void
  onResend: () => void
  onBackToForm: () => void
}) {
  return (
    <AuthShell>
      <form onSubmit={onSubmit} className="space-y-4">
        {infoMessage && (
          <div className="flex items-start gap-2 border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            <MailCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{infoMessage}</span>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="otpCode" className="text-xs text-muted-foreground">
            Verification code
          </Label>
          <Input
            id="otpCode"
            type="text"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            required
            autoComplete="one-time-code"
            value={otpCode}
            onChange={(e) => onOtpCodeChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className="h-12 bg-card text-center text-[18px] tracking-[0.5em]"
            placeholder="000000"
            autoFocus
          />
        </div>

        {error && (
          <p className="border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}

        <Button
          type="submit"
          disabled={loading || otpCode.length !== 6}
          className="group h-10 w-full"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Verifying
            </>
          ) : (
            <>
              Verify and continue
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </>
          )}
        </Button>

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={onResend}
            disabled={loading}
            className="text-xs text-muted-foreground underline underline-offset-4 transition-opacity hover:opacity-80 disabled:opacity-50"
          >
            Resend code
          </button>
          <button
            type="button"
            onClick={onBackToForm}
            className="text-xs text-muted-foreground underline underline-offset-4 transition-opacity hover:opacity-80"
          >
            Use different email
          </button>
        </div>
      </form>
    </AuthShell>
  )
}

function CreateAccountForm({
  name,
  onNameChange,
  email,
  onEmailChange,
  password,
  onPasswordChange,
  confirmPassword,
  onConfirmPasswordChange,
  passwordsMatch,
  error,
  loading,
  canSubmit,
  onSubmit,
}: {
  name: string
  onNameChange: (value: string) => void
  email: string
  onEmailChange: (value: string) => void
  password: string
  onPasswordChange: (value: string) => void
  confirmPassword: string
  onConfirmPasswordChange: (value: string) => void
  passwordsMatch: boolean
  error: string | null
  loading: boolean
  canSubmit: boolean
  onSubmit: (e: React.FormEvent) => void
}) {
  return (
    <AuthShell>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="name" className="text-xs text-muted-foreground">
            Name
          </Label>
          <Input
            id="name"
            type="text"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            required
            autoComplete="name"
            className="h-10 bg-input/50 ring-1 ring-white/10"
            autoFocus
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="email" className="text-xs text-muted-foreground">
            Email
          </Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            required
            autoComplete="email"
            className="h-10 bg-input/50 ring-1 ring-white/10"
            placeholder="you@example.com"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password" className="text-xs text-muted-foreground">
            Password
          </Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            required
            autoComplete="new-password"
            className="h-10 bg-input/50 ring-1 ring-white/10"
            placeholder="Create a password"
          />
          {password.length > 0 && <PasswordRules password={password} />}
        </div>

        <div className="space-y-1.5">
          <Label
            htmlFor="confirmPassword"
            className="text-xs text-muted-foreground"
          >
            Confirm password
          </Label>
          <Input
            id="confirmPassword"
            type="password"
            value={confirmPassword}
            onChange={(e) => onConfirmPasswordChange(e.target.value)}
            required
            autoComplete="new-password"
            className="h-10 bg-input/50 ring-1 ring-white/10"
            placeholder="Repeat the password"
          />
          {confirmPassword.length > 0 && !passwordsMatch && (
            <p className="text-xs text-destructive">Passwords do not match</p>
          )}
        </div>

        {error && (
          <p className="border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}

        <Button
          type="submit"
          disabled={loading || !canSubmit}
          className="group h-10 w-full"
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Creating account
            </>
          ) : (
            <>
              Create account
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </>
          )}
        </Button>

        <p className="text-center text-xs text-muted-foreground">
          Already have an account?{" "}
          <Link
            href="/login"
            className="text-foreground underline underline-offset-4 transition-opacity hover:opacity-80"
          >
            Sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  )
}

export default function SetupPage() {
  const router = useRouter()
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [step, setStep] = useState<"form" | "otp">("form")
  const [otpCode, setOtpCode] = useState("")
  const [infoMessage, setInfoMessage] = useState<string | null>(null)

  const checks = validatePassword(password)
  const allChecksPassed =
    checks.minLength && checks.hasLetter && checks.hasNumber
  const passwordsMatch = password === confirmPassword
  const canSubmit = allChecksPassed && passwordsMatch && email.length > 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (password !== confirmPassword) {
      setError("Passwords do not match")
      return
    }

    setLoading(true)

    try {
      const res = await backendFetch("/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => null)
        if (data?.detail) {
          setError(data.detail)
        } else {
          // No usable JSON detail — usually means the response wasn't JSON
          // (e.g. a 404 HTML page from a misconfigured proxy, or a 502 from
          // a dead backend). Log the raw status + content type so the cause
          // is visible in the browser console instead of a generic error.
          console.error(
            `[setup] POST /auth/setup returned HTTP ${res.status} ` +
              `with content-type "${res.headers.get("content-type") ?? "unknown"}"`,
          )
          setError(
            `Couldn't reach the server (HTTP ${res.status}). ` +
              "Check the browser console for details.",
          )
        }
        return
      }

      const data = await res.json()

      if (data.status === "verification_required") {
        setStep("otp")
        setInfoMessage(`We sent a 6-digit verification code to ${email}. Enter it below to activate your account.`)
        return
      }

      await proceedToSignIn()
    } catch {
      setError("Unable to connect to server")
    } finally {
      setLoading(false)
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setInfoMessage(null)
    setLoading(true)

    try {
      const res = await backendFetch("/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: otpCode }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setError(data?.detail ?? "Invalid or expired code")
        return
      }

      await proceedToSignIn()
    } catch {
      setError("Unable to connect to server")
    } finally {
      setLoading(false)
    }
  }

  async function handleResend() {
    setError(null)
    setInfoMessage(null)
    setLoading(true)

    try {
      const res = await backendFetch("/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      })

      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After")
        const seconds = retryAfter ? parseInt(retryAfter, 10) : 60
        setError(`Please wait ${seconds}s before requesting a new code.`)
        return
      }

      setInfoMessage(`A new verification code has been sent to ${email}.`)
      setOtpCode("")
    } catch {
      setError("Unable to connect to server")
    } finally {
      setLoading(false)
    }
  }

  async function proceedToSignIn() {
    const result = await signIn("credentials", {
      email,
      password,
      redirect: false,
      redirectTo: "/",
    })
    if (result?.error) {
      setError("Account created but sign-in failed. Please log in.")
      router.push("/login")
      return
    }
    router.push("/")
  }

  if (step === "otp") {
    return (
      <OtpStep
        otpCode={otpCode}
        onOtpCodeChange={setOtpCode}
        infoMessage={infoMessage}
        error={error}
        loading={loading}
        onSubmit={handleVerifyOtp}
        onResend={handleResend}
        onBackToForm={() => {
          setStep("form")
          setOtpCode("")
          setError(null)
          setInfoMessage(null)
        }}
      />
    )
  }

  return (
    <CreateAccountForm
      name={name}
      onNameChange={setName}
      email={email}
      onEmailChange={setEmail}
      password={password}
      onPasswordChange={setPassword}
      confirmPassword={confirmPassword}
      onConfirmPasswordChange={setConfirmPassword}
      passwordsMatch={passwordsMatch}
      error={error}
      loading={loading}
      canSubmit={canSubmit}
      onSubmit={handleSubmit}
    />
  )
}
