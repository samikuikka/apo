"use client"

import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import {
  type ApiKey,
  type ApiKeyRotateResponse,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
} from "@/lib/api-keys-api"
import { listProjects, type Project } from "@/lib/projects-api"
import { ApiKeyRevealDialog, type ApiKeyRevealPayload } from "@/components/api-key-created-dialog"
import { ApiKeyCreateDialog } from "@/components/admin/api-key-create-dialog"
import { ApiKeyRow } from "@/components/admin/api-key-row"
import { KeyRound, Loader2, Plus, RefreshCw, ChevronDown } from "lucide-react"

type RevealState = { payload: ApiKeyRevealPayload; action: "created" | "rotated" } | null

export function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [reveal, setReveal] = useState<RevealState>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProject, setSelectedProject] = useState<string>("")

  useEffect(() => {
    listProjects().then((ps) => {
      setProjects(ps)
    }).catch(() => {})
  }, [])

  // Derive the effective project: fall back to the first project when the
  // user hasn't explicitly picked one.
  const effectiveProject = selectedProject ?? projects[0]?.id

  const fetchKeys = useCallback(async () => {
    if (!effectiveProject) return
    setLoading(true)
    try {
      setKeys(await listApiKeys(effectiveProject))
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to load API keys")
    } finally {
      setLoading(false)
    }
  }, [effectiveProject])

  useEffect(() => {
    fetchKeys()
  }, [fetchKeys])

  async function handleCreated(payload: ApiKeyRevealPayload) {
    setReveal({ payload, action: "created" })
    fetchKeys()
  }

  async function handleRotate(id: string) {
    try {
      const result: ApiKeyRotateResponse = await rotateApiKey(id)
      setReveal({ payload: result, action: "rotated" })
      fetchKeys()
      toast.success("Key rotated")
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to rotate key")
    }
  }

  async function handleRevoke(id: string) {
    try {
      await revokeApiKey(id)
      setKeys((prev) => prev.filter((k) => k.id !== id))
      toast.success("Key deleted")
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to delete key")
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">API Keys</h2>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground tabular-nums">
              {keys.length}
            </span>
          </div>
          {projects.length > 0 && (
            <div className="relative">
              <select
                value={effectiveProject ?? ""}
                aria-label="Filter by project"
                onChange={(e) => setSelectedProject(e.target.value)}
                className="appearance-none rounded-md border border-border bg-background px-3 py-1 pr-7 text-xs text-foreground outline-none focus:border-primary"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={fetchKeys}
            disabled={loading}
            aria-label="Refresh keys"
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            Create key
          </Button>
        </div>
      </div>

      <div className="overflow-hidden border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : keys.length === 0 ? (
          <EmptyState onCreate={() => setCreateOpen(true)} />
        ) : (
          <ul className="divide-y">
            {keys.map((key) => (
              <ApiKeyRow
                key={key.id}
                apiKey={key}
                onRotate={handleRotate}
                onRevoke={handleRevoke}
              />
            ))}
          </ul>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Public keys (<code className="font-mono">pk-apo-…</code>) are safe to share and grant
        ingest-only access. Secret keys (<code className="font-mono">sk-apo-…</code>) grant full
        access — store them server-side.
      </p>

      <ApiKeyCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
        defaultProject={effectiveProject || "example-service"}
      />

      <ApiKeyRevealDialog
        open={reveal !== null}
        onDone={() => setReveal(null)}
        payload={reveal?.payload ?? null}
        action={reveal?.action}
      />
    </div>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted">
        <KeyRound className="size-5 text-muted-foreground" />
      </span>
      <div>
        <p className="text-sm font-medium">No API keys yet</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Create a key to authenticate SDK and CLI requests.
        </p>
      </div>
      <Button type="button" size="sm" onClick={onCreate}>
        <Plus className="size-4" />
        Create your first key
      </Button>
    </div>
  )
}
