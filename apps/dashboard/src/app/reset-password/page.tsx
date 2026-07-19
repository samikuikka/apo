"use client"

import { Suspense, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { Loader2 } from "lucide-react"
import AuthShell from "@/components/auth/auth-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { backendFetch } from "@/lib/backend-fetch"

const PASSWORD_RULES = [
  { id: "min-length", label: "At least 8 characters" },
  { id: "has-letter", label: "At least one letter" },
  { id: "has-number", label: "At least one number" },
] as const

function validatePassword(password: string) {
  return {
    minLength: password.length >= 8,
    hasLetter: /[a-zA-Z]/.test(password),
    hasNumber: /\d/.test(password),
  }
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  )
}

function ResetPasswordForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get("token") ?? ""

  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const checks = validatePassword(newPassword)
  const allChecksPassed = checks.minLength && checks.hasLetter && checks.hasNumber
  const passwordsMatch = newPassword === confirmPassword
  const canSubmit = allChecksPassed && passwordsMatch && token.length > 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match")
      return
    }

    setLoading(true)

    try {
      const res = await backendFetch("/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, new_password: newPassword }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => null)
        setError(data?.detail ?? "Failed to reset password")
        return
      }

      router.push("/login?reset=success")
    } catch {
      setError("Unable to connect to server")
    } finally {
      setLoading(false)
    }
  }

  if (!token) {
    return (
      <AuthShell>
        <Link href="/forgot-password">
          <Button type="button" className="h-10 w-full">
            Request a new reset link
          </Button>
        </Link>
      </AuthShell>
    )
  }

  return (
    <AuthShell>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="new-password" className="text-xs text-muted-foreground">
            New password
          </Label>
          <Input
            id="new-password"
            type="password"
            required
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="h-10 bg-input/50 ring-1 ring-white/10"
            placeholder="Create a new password"
            autoFocus
          />
          {newPassword.length > 0 && (
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
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="confirm-password" className="text-xs text-muted-foreground">
            Confirm password
          </Label>
          <Input
            id="confirm-password"
            type="password"
            required
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="h-10 bg-input/50 ring-1 ring-white/10"
            placeholder="Repeat the new password"
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
              Resetting...
            </>
          ) : (
            "Reset password"
          )}
        </Button>
      </form>
    </AuthShell>
  )
}
