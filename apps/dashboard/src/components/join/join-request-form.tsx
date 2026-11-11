"use client"

import { useState } from "react"
import { ArrowRight, Loader2, MailCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ErrorBanner } from "@/components/ui/error-banner"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { requestHostedAccessInvitation } from "@/lib/hosted-access-api"

type Phase =
  | { kind: "editing"; error: string | null }
  | { kind: "submitting" }
  | { kind: "sent"; message: string }

export default function JoinRequestForm() {
  const [email, setEmail] = useState("")
  const [phase, setPhase] = useState<Phase>({ kind: "editing", error: null })

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setPhase({ kind: "submitting" })
    try {
      const { message } = await requestHostedAccessInvitation(email.trim())
      setPhase({ kind: "sent", message })
    } catch (err) {
      setPhase({
        kind: "editing",
        error: err instanceof Error ? err.message : "Unable to reach server.",
      })
    }
  }

  if (phase.kind === "sent") {
    return (
      <div className="text-center">
        <MailCheck className="mx-auto mb-3 size-8 text-success" />
        <h1 className="text-[18px] font-semibold">Check your inbox</h1>
        <p className="mt-2 text-xs text-muted-foreground">{phase.message}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          The link in the email works once. Open it to create your account
          and your Project.
        </p>
      </div>
    )
  }

  const submitting = phase.kind === "submitting"
  return (
    <>
      <div className="mb-5 text-center">
        <h1 className="text-[20px] font-semibold">Request an Invitation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter your email and we&rsquo;ll send you a link to create your
          account and a Project of your own.
        </p>
      </div>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="request-email" className="text-xs text-muted-foreground">
            Email
          </Label>
          <Input
            id="request-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            autoFocus
            className="h-10 bg-input/50 ring-1 ring-white/10"
            placeholder="you@example.com"
          />
        </div>

        {phase.kind === "editing" && phase.error && (
          <ErrorBanner>{phase.error}</ErrorBanner>
        )}

        <Button
          type="submit"
          disabled={submitting || email.trim().length === 0}
          className="group h-10 w-full"
        >
          {submitting ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Requesting…
            </>
          ) : (
            <>
              Request Invitation
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </>
          )}
        </Button>
      </form>
    </>
  )
}
