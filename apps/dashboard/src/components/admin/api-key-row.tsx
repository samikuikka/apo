"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Check, Copy, MoreVertical, RefreshCw, Trash2 } from "lucide-react"
import { toast } from "sonner"
import type { ApiKey } from "@/lib/api-keys-api"
import { formatRelativeTime } from "@/lib/format"

interface ApiKeyRowProps {
  apiKey: ApiKey
  onRotate: (id: string) => void
  onRevoke: (id: string) => void
}

export function ApiKeyRow({ apiKey, onRotate, onRevoke }: ApiKeyRowProps) {
  const [copied, setCopied] = useState(false)
  const [rotateOpen, setRotateOpen] = useState(false)
  const [revokeOpen, setRevokeOpen] = useState(false)

  const expires = apiKey.expires_at ? new Date(apiKey.expires_at) : null
  const isExpired = expires ? expires < new Date() : false

  function copyIdentifier() {
    const id = apiKey.publicKey ?? apiKey.prefix
    navigator.clipboard.writeText(id)
    setCopied(true)
    toast.success("Copied to clipboard")
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <li className="group flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{apiKey.name}</span>
          <Badge variant="secondary" className="capitalize">{apiKey.scope}</Badge>
          {isExpired && <Badge variant="destructive">Expired</Badge>}
        </div>

        <button
          type="button"
          onClick={copyIdentifier}
          className="mt-1.5 inline-flex max-w-full items-center gap-1.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
          title={apiKey.publicKey ? "Copy public key" : "Copy key prefix"}
        >
          <code className="truncate">
            {apiKey.publicKey
              ? apiKey.publicKey
              : `${apiKey.prefix}••••`}
          </code>
          {apiKey.displaySecretKey && (
            <code className="truncate text-muted-foreground/60">
              {apiKey.displaySecretKey}
            </code>
          )}
          {copied ? (
            <Check className="size-3 shrink-0 text-success" />
          ) : (
            <Copy className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
          )}
        </button>

        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground/70">
          <span className="font-medium text-muted-foreground">{apiKey.project}</span>
          <span aria-hidden>·</span>
          <span>created {formatRelativeTime(apiKey.created_at)}</span>
          {apiKey.last_used_at && (
            <>
              <span aria-hidden>·</span>
              <span>last used {formatRelativeTime(apiKey.last_used_at)}</span>
            </>
          )}
          {expires && !isExpired && (
            <>
              <span aria-hidden>·</span>
              <span>expires {expires.toLocaleDateString("en-US", { timeZone: "UTC" })}</span>
            </>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="opacity-60 transition-opacity group-hover:opacity-100"
              aria-label={`Actions for ${apiKey.name}`}
            >
              <MoreVertical className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>{apiKey.name}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={copyIdentifier}>
              <Copy className="size-4" />
              Copy identifier
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setRotateOpen(true)}>
              <RefreshCw className="size-4" />
              Rotate key
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setRevokeOpen(true)}>
              <Trash2 className="size-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AlertDialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate this key?</AlertDialogTitle>
            <AlertDialogDescription>
              A new key pair will be generated and the current one will stop working immediately.
              You&apos;ll be shown the new secret once — copy it before closing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="default" onClick={() => onRotate(apiKey.id)}>
              Rotate key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this key?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes <span className="font-medium text-foreground">{apiKey.name}</span> and
              cannot be undone. Any service using it will stop authenticating immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => onRevoke(apiKey.id)}>
              Delete key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  )
}
