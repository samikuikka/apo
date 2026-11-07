"use client"

import { useCallback, useEffect, useReducer, useState } from "react"
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
import { ShikiCodeBlock } from "@/components/shiki-code-block"
import { Check, Copy, KeyRound, Loader2, Plus, RefreshCw, ChevronDown } from "lucide-react"

type RevealState = { payload: ApiKeyRevealPayload; action: "created" | "rotated" } | null

// ----------------------------------------------------------------------------
// Reducers for ApiKeysSection.
//
// {keys, loading} is a fetch machine — both slices transition together on
// every fetch. {projects, selectedProject} is the project filter: the
// selection and the loaded project list jointly own the effective-project
// fallback, so they live in one state. Unrelated single-value UI state (the
// create dialog and reveal dialog) stays as independent useStates.
// ----------------------------------------------------------------------------

interface KeysState {
  keys: ApiKey[]
  loading: boolean
}

type KeysAction =
  | { type: "FETCH_START" }
  | { type: "FETCH_LOADED"; keys: ApiKey[] }
  | { type: "FETCH_ERROR" }
  | { type: "KEY_REVOKED"; id: string }

const initialKeysState: KeysState = { keys: [], loading: true }

function keysReducer(state: KeysState, action: KeysAction): KeysState {
  switch (action.type) {
    case "FETCH_START":
      return { ...state, loading: true }
    case "FETCH_LOADED":
      return { keys: action.keys, loading: false }
    case "FETCH_ERROR":
      // keep stale keys on screen; only the spinner goes away
      return { ...state, loading: false }
    case "KEY_REVOKED":
      return { ...state, keys: state.keys.filter((k) => k.id !== action.id) }
  }
}

interface ProjectFilterState {
  projects: Project[]
  selectedProject: string
}

type ProjectFilterAction =
  | { type: "PROJECTS_LOADED"; projects: Project[] }
  | { type: "PROJECT_SELECTED"; projectId: string }

const initialProjectFilterState: ProjectFilterState = {
  projects: [],
  selectedProject: "",
}

function projectFilterReducer(
  state: ProjectFilterState,
  action: ProjectFilterAction,
): ProjectFilterState {
  switch (action.type) {
    case "PROJECTS_LOADED":
      return { ...state, projects: action.projects }
    case "PROJECT_SELECTED":
      return { ...state, selectedProject: action.projectId }
  }
}

export function ApiKeysSection() {
  const [keysState, dispatchKeys] = useReducer(keysReducer, initialKeysState)
  const { keys, loading } = keysState
  const [filter, dispatchFilter] = useReducer(
    projectFilterReducer,
    initialProjectFilterState,
  )
  const { projects, selectedProject } = filter
  const [createOpen, setCreateOpen] = useState(false)
  const [reveal, setReveal] = useState<RevealState>(null)

  useEffect(() => {
    listProjects().then((ps) => {
      dispatchFilter({ type: "PROJECTS_LOADED", projects: ps })
    }).catch(() => {})
  }, [])

  // Derive the effective project: fall back to the first project when the
  // user hasn't explicitly picked one. Issue #73: use ``||`` not ``??`` —
  // ``selectedProject`` starts as "" (not nullish), so ``??`` never fell back.
  const effectiveProject = selectedProject || projects[0]?.id

  const fetchKeys = useCallback(async () => {
    if (!effectiveProject) return
    dispatchKeys({ type: "FETCH_START" })
    try {
      dispatchKeys({ type: "FETCH_LOADED", keys: await listApiKeys(effectiveProject) })
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to load API keys")
      dispatchKeys({ type: "FETCH_ERROR" })
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
      dispatchKeys({ type: "KEY_REVOKED", id })
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
                onChange={(e) => dispatchFilter({ type: "PROJECT_SELECTED", projectId: e.target.value })}
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

      <ConnectServiceCard />

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
                onGuardrailsChanged={fetchKeys}
              />
            ))}
          </ul>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Public keys (<code className="font-mono">pk-apo-…</code>) are stable identifiers —
        they do not authorize requests by themselves. Secret keys
        (<code className="font-mono">sk-apo-…</code>) are required alongside the public key
        and must be stored server-side.
      </p>

      <ApiKeyCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
        projects={projects}
        defaultProject={effectiveProject}
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


function CopyLine({ label, code, language }: { label: string; code: string; language: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="min-w-0 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Copy ${label}`}
          onClick={() => {
            navigator.clipboard.writeText(code)
            setCopied(true)
            toast.success("Copied")
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
      <ShikiCodeBlock code={code} language={language} defaultWrapped />
    </div>
  )
}

function ConnectServiceCard() {
  const [origin, setOrigin] = useState("")
  useEffect(() => setOrigin(window.location.origin), [])
  if (!origin) return null
  const endpoint = `${origin}/api/public/otel/v1/traces`
  return (
    <section className="border bg-card p-4" aria-label="Connect a service">
      <h3 className="text-sm font-semibold">Connect a service</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Point any OpenTelemetry SDK at apo with an ingest-scope key (create one above —
        quota is per key). Traces appear on the Traces page, no agent runs needed.
      </p>
      <div className="mt-3 grid gap-3">
        <CopyLine label="OTLP endpoint" code={endpoint} language="text" />
        <CopyLine
          label="Python (opentelemetry-exporter-otlp-proto-http)"
          language="python"
          code={`from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
import base64

auth = "Basic " + base64.b64encode(b"<pk-apo-...>:<sk-apo-...>").decode()
exporter = OTLPSpanExporter(endpoint="${endpoint}", headers={"Authorization": auth})`}
        />
        <CopyLine
          label="curl"
          language="bash"
          code={`curl -u "<pk-apo-...>:<sk-apo-...>" ${endpoint} \\
  -H "Content-Type: application/json" \\
  -d '{
    "resourceSpans": [{
      "resource": {
        "attributes": [
          { "key": "service.name", "value": { "stringValue": "my-service" } }
        ]
      },
      "scopeSpans": [{
        "scope": {},
        "spans": [
          { "traceId": "<32-hex>", "spanId": "<16-hex>", "name": "hello" }
        ]
      }]
    }]
  }'`}
        />
      </div>
    </section>
  )
}
