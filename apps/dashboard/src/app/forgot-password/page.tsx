"use client"

import { useState } from "react"
import Link from "next/link"
import { Loader2, Mail } from "lucide-react"
import AuthShell from "@/components/auth/auth-shell"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { backendFetch } from "@/lib/backend-fetch"

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("")
  const [loading, setLoading] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)

    try {
      await backendFetch("/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      })
      setSubmitted(true)
    } catch {
      setSubmitted(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell>
      {submitted ? (
        <div className="space-y-4">
          <div className="flex items-center justify-center py-4">
            <div className="rounded-full bg-muted p-3">
              <Mail className="h-6 w-6 text-muted-foreground" />
            </div>
          </div>
          <p className="text-sm text-center text-muted-foreground">
            If an account exists with that email, a reset link has been sent.
            Check your email for the reset link.
          </p>
          <Link href="/login">
            <Button type="button" className="h-10 w-full">
              Back to login
            </Button>
          </Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
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
              autoFocus
            />
          </div>

          <Button
            type="submit"
            disabled={loading}
            className="group h-10 w-full"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Sending...
              </>
            ) : (
              "Send reset link"
            )}
          </Button>
        </form>
      )}
    </AuthShell>
  )
}