"use client"

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Check, Copy, Eye, EyeOff, KeyRound } from "lucide-react"
import { toast } from "sonner"

/** Payload shared by create and rotate responses — only the bits we reveal once. */
export type ApiKeyRevealPayload = {
  publicKey?: string | null
  secretKey?: string | null
  /** Legacy single-key model (sk-xxx). Mutually exclusive with secretKey. */
  key?: string | null
  displaySecretKey?: string | null
}

interface ApiKeyRevealDialogProps {
  open: boolean
  onDone: () => void
  payload: ApiKeyRevealPayload | null
  /** Heading text. Defaults to "create"; pass "rotated" after a rotation. */
  action?: "created" | "rotated"
}

export function ApiKeyRevealDialog({
  open,
  onDone,
  payload,
  action = "created",
}: ApiKeyRevealDialogProps) {
  const [showSecret, setShowSecret] = useState(false)

  const secret = payload?.secretKey ?? payload?.key ?? null
  const maskedSecret = payload?.displaySecretKey ?? "••••••••••••"

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onDone()
      }}
    >
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-1 flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-full bg-primary/10">
              <KeyRound className="size-4 text-primary" />
            </span>
            <DialogTitle>
              {action === "rotated" ? "Key rotated" : "API key created"}
            </DialogTitle>
          </div>
          <DialogDescription>
            Copy your secret key now — it can&apos;t be shown again. Treat it like a password.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {payload?.publicKey && (
            <KeyCopyField label="Public key" value={payload.publicKey} hint="Safe to share. Grants ingest-only access on its own." />
          )}
          {secret && (
            <KeyCopyField
              label="Secret key"
              value={secret}
              maskedValue={maskedSecret}
              revealed={showSecret}
              onToggleReveal={() => setShowSecret((s) => !s)}
              hint="Server-side only. Grants full access when paired with the public key."
            />
          )}
        </div>

        <div className="flex justify-end pt-1">
          <Button type="button" onClick={onDone}>
            I&apos;ve saved my key
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function KeyCopyField({
  label,
  value,
  maskedValue,
  revealed = true,
  onToggleReveal,
  hint,
}: {
  label: string
  value: string
  maskedValue?: string
  revealed?: boolean
  onToggleReveal?: () => void
  hint?: string
}) {
  const [copied, setCopied] = useState(false)
  const display = revealed ? value : (maskedValue ?? "•".repeat(value.length))

  function handleCopy() {
    navigator.clipboard.writeText(value)
    setCopied(true)
    toast.success(`${label} copied`)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {hint && <span className="text-[10px] text-muted-foreground/70">{hint}</span>}
      </div>
      <div className="flex items-center gap-1.5 rounded-md border bg-muted/40 p-1.5">
        <code className="min-w-0 flex-1 break-all px-1.5 font-mono text-xs">{display}</code>
        {onToggleReveal && (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={revealed ? "Hide secret" : "Show secret"}
            onClick={onToggleReveal}
            className="shrink-0"
          >
            {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </Button>
        )}
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Copy ${label}`}
          onClick={handleCopy}
          className="shrink-0"
        >
          {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
    </div>
  )
}
