"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Github, Loader2, AlertCircle, ChevronDown, Check, GitBranch, Folder } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { cn } from "@/lib/utils";
import { FolderBrowser } from "./FolderBrowser";
import { useGithubRepoPicker } from "./use-github-repo-picker";
import {
  type ProjectTaskSource,
  type ProjectTaskSourceFormData,
  type ProjectTaskSourceType,
  syncProjectTaskSource,
  updateProjectTaskSource,
} from "@/lib/projects-api";
import {
  type GithubAvailability,
  type GithubRepo,
  getGithubAvailability,
} from "@/lib/github-api";

type SubmitState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "syncing" }
  | { kind: "error"; message: string };

// Which setup path the user has picked. The stored ``source_type`` is
// still just "git" | "filesystem" — the "github" path produces a git
// source whose URL/ref come from the connected GitHub repo picker.
type Method = "github" | "manual-git" | "filesystem";

interface ProjectTaskSourceFormProps {
  projectId: string;
  initialValue: ProjectTaskSource | null;
  onSaved?: (source: ProjectTaskSource) => void;
}

export function ProjectTaskSourceForm({
  projectId,
  initialValue,
  onSaved,
}: ProjectTaskSourceFormProps) {
  const router = useRouter();

  // Initial method is derived from the existing source (if any).
  // GitHub-URL git sources reopen on the GitHub path so the OAuth
  // connection + repo picker stay visible in edit mode.
  const initialMethod: Method = initialValue
    ? initialValue.source_type === "filesystem"
      ? "filesystem"
      : initialValue.repository_url?.includes("github.com")
        ? "github"
        : "manual-git"
    : "github";

  const [method, setMethod] = useState<Method>(initialMethod);
  const [githubAvail, setGithubAvail] = useState<GithubAvailability | null>(null);

  const [displayName, setDisplayName] = useState(initialValue?.display_name ?? "");
  const [repositoryUrl, setRepositoryUrl] = useState(
    initialValue?.repository_url ?? "",
  );
  const [gitRef, setGitRef] = useState(initialValue?.git_ref ?? "main");
  const [subpath, setSubpath] = useState(initialValue?.subpath ?? "");
  const [filesystemPath, setFilesystemPath] = useState(
    initialValue?.filesystem_path ?? "",
  );
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: "idle" });

  // GitHub OAuth availability — lifted here so the method selector can
  // hide the GitHub option entirely when OAuth is not configured.
  useEffect(() => {
    let cancelled = false;
    getGithubAvailability(projectId)
      .then((a) => {
        if (!cancelled) setGithubAvail(a);
        if (a && !a.enabled) setMethod(m => m === "github" ? "manual-git" : m);
      })
      .catch(() => {
        if (!cancelled) setGithubAvail({ enabled: false, client_id: null });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitState.kind === "saving" || submitState.kind === "syncing") return;

    // --- Build payload ---
    const sourceType: ProjectTaskSourceType =
      method === "filesystem" ? "filesystem" : "git";
    const payload: ProjectTaskSourceFormData = { source_type: sourceType };
    const trimmedDisplayName = displayName.trim();
    if (trimmedDisplayName) payload.display_name = trimmedDisplayName;

    if (sourceType === "git") {
      const url = repositoryUrl.trim();
      if (!url) {
        setSubmitState({
          kind: "error",
          message:
            method === "github"
              ? "Connect GitHub and pick a repository first."
              : "Repository URL is required for Git sources.",
        });
        return;
      }
      payload.repository_url = url;
      payload.git_ref = gitRef.trim() || "main";
      const trimmedSubpath = subpath.trim();
      if (trimmedSubpath) payload.subpath = trimmedSubpath;
    } else {
      const path = filesystemPath.trim();
      if (!path) {
        setSubmitState({
          kind: "error",
          message: "Filesystem path is required for filesystem sources.",
        });
        return;
      }
      payload.filesystem_path = path;
    }

    // --- Phase 1: Save ---
    setSubmitState({ kind: "saving" });
    let saved: ProjectTaskSource;
    try {
      saved = await updateProjectTaskSource(projectId, payload);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to save task source.";
      setSubmitState({ kind: "error", message });
      return;
    }

    // --- Phase 2: Sync (chained automatically) ---
    setSubmitState({ kind: "syncing" });
    try {
      const synced = await syncProjectTaskSource(projectId);
      toast.success("Task source saved and synced");
      setSubmitState({ kind: "idle" });
      onSaved?.(synced);
      router.refresh();
    } catch {
      // Save succeeded but sync failed — still transition to status
      // panel so the user sees the error and can retry sync there.
      toast.error("Saved, but sync failed");
      setSubmitState({ kind: "idle" });
      onSaved?.(saved);
      router.refresh();
    }
  }

  const submitting = submitState.kind === "saving" || submitState.kind === "syncing";
  const errorMessage = submitState.kind === "error" ? submitState.message : null;
  const githubEnabled = githubAvail?.enabled ?? false;

  return (
    <form className="flex flex-col gap-5" onSubmit={handleSubmit}>
      {/* Method selector — equal-weight peer options. Replaces the old
          hero GitHub button + hidden disclosure. Each option just
          selects the path; contextual fields render below. */}
      <div className="flex flex-col gap-2">
        {githubEnabled && (
          <SourceOption
            icon={Github}
            label="GitHub"
            description="Connect to browse your repositories"
            selected={method === "github"}
            onSelect={() => setMethod("github")}
          />
        )}
        <SourceOption
          icon={GitBranch}
          label="Git URL"
          description="Paste any Git repository URL"
          selected={method === "manual-git"}
          onSelect={() => setMethod("manual-git")}
        />
        <SourceOption
          icon={Folder}
          label="Local filesystem"
          description="Point to a folder reachable from the backend"
          selected={method === "filesystem"}
          onSelect={() => setMethod("filesystem")}
        />
      </div>

      {/* Contextual fields per method. */}
      {method === "github" && (
        <Suspense fallback={null}>
          <GithubConnectSection
            projectId={projectId}
            availability={githubAvail}
            initialValue={initialValue}
            disabled={submitting}
            subpath={subpath}
            onSubpathChange={setSubpath}
            onPickRepo={(repo) => {
              if (repo) {
                setRepositoryUrl(repo.clone_url);
                setGitRef(repo.default_branch || "main");
              }
            }}
            onPickBranch={(branch) => {
              if (branch) setGitRef(branch);
            }}
          />
        </Suspense>
      )}

      {method === "manual-git" && (
        <GitManualFields
          repositoryUrl={repositoryUrl}
          gitRef={gitRef}
          subpath={subpath}
          disabled={submitting}
          onRepositoryUrlChange={setRepositoryUrl}
          onGitRefChange={setGitRef}
          onSubpathChange={setSubpath}
        />
      )}

      {method === "filesystem" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="task-source-filesystem-path">Path</Label>
          <Input
            id="task-source-filesystem-path"
            type="text"
            value={filesystemPath}
            onChange={(e) => setFilesystemPath(e.target.value)}
            placeholder="/srv/repos/my-project"
            disabled={submitting}
            className="font-mono"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            Directory that directly contains your task folders (the ones holding
            <span className="font-mono"> *.eval.ts</span> files). Must be reachable from the backend process.
          </p>
        </div>
      )}

      {initialValue !== null && (
        <div className="flex flex-col gap-1.5 border-t border-border/60 pt-4">
          <Label htmlFor="task-source-display-name">
            Display name (optional)
          </Label>
          <Input
            id="task-source-display-name"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={defaultDisplayName(method)}
            disabled={submitting}
          />
          <p className="text-xs text-muted-foreground">
            Shown in the status panel header.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p
          className="min-h-[1rem] text-xs"
          role={errorMessage ? "alert" : undefined}
          aria-live="polite"
        >
          {errorMessage ? (
            <span className="text-destructive">{errorMessage}</span>
          ) : null}
        </p>
        <Button type="submit" size="sm" disabled={submitting}>
          {submitState.kind === "saving" ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              Saving…
            </>
          ) : submitState.kind === "syncing" ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              Syncing…
            </>
          ) : (
            "Save & sync"
          )}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Source method option (peer selector)
// ---------------------------------------------------------------------------

interface SourceOptionProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}

function SourceOption({
  icon: Icon,
  label,
  description,
  selected,
  onSelect,
}: SourceOptionProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-center gap-3 border px-3 py-2.5 text-left transition-colors",
        selected
          ? "border-foreground bg-card"
          : "border-border bg-transparent hover:border-foreground/30 hover:bg-muted/20",
      )}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="flex flex-col">
        <span className="text-[13px] font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// GitHub Connect section
// ---------------------------------------------------------------------------

interface GithubConnectSectionProps {
  projectId: string;
  availability: GithubAvailability | null;
  initialValue: ProjectTaskSource | null;
  disabled: boolean;
  subpath: string;
  onSubpathChange: (value: string) => void;
  onPickRepo: (repo: GithubRepo) => void;
  onPickBranch: (branch: string) => void;
}

function GithubConnectSection({
  projectId,
  availability,
  initialValue,
  disabled,
  subpath,
  onSubpathChange,
  onPickRepo,
  onPickBranch,
}: GithubConnectSectionProps) {
  const gh = useGithubRepoPicker(projectId, availability, initialValue, {
    onPickRepo,
    onPickBranch,
  });

  // Hidden until we know whether GitHub Connect is configured.
  if (!gh.ready || !gh.available) return null;

  return (
    <div className="flex flex-col gap-3">
      {gh.connection && (
        <header className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-[13px] font-medium">
            <Github className="size-3.5" />
            Connected as @{gh.connection.github_username ?? "user"}
          </div>
          {!disabled && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={gh.disconnect}
            >
              Disconnect
            </Button>
          )}
        </header>
      )}

      {gh.error && (
        <div
          role="alert"
          className="flex items-start gap-1.5 border border-destructive/30 bg-destructive/5 p-2 text-[11px] text-destructive"
        >
          <AlertCircle className="mt-0.5 size-3 shrink-0" />
          <span className="flex-1">{gh.error}</span>
        </div>
      )}

      {!gh.connection && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">
            Authorize with GitHub to browse your repositories and pick a branch.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={gh.connect}
            disabled={disabled || gh.loading === "connect"}
            className="w-fit gap-2"
          >
            {gh.loading === "connect" ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Redirecting…
              </>
            ) : (
              <>
                <Github className="size-3.5" />
                Connect GitHub
              </>
            )}
          </Button>
        </div>
      )}

      {gh.connection && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <Label className="text-[11px]">Repository</Label>
            <SearchableSelect
              items={gh.repos.map((r) => ({
                value: r.full_name,
                label: r.full_name + (r.private ? " (private)" : ""),
              }))}
              value={gh.selectedRepoFullName}
              onChange={gh.selectRepo}
              placeholder={
                gh.loading === "repos"
                  ? "Loading repos…"
                  : gh.repos.length === 0
                    ? "No repositories found"
                    : "Select a repository…"
              }
              searchPlaceholder="Search repositories…"
              emptyText="No repos match"
              disabled={disabled || gh.loading === "repos"}
            />
          </div>

          {gh.selectedRepoFullName && (
            <div className="flex flex-col gap-1">
              <Label className="text-[11px]">Branch</Label>
              <SearchableSelect
                items={gh.branches.map((b) => ({
                  value: b.name,
                  label: b.name + (b.protected ? " (protected)" : ""),
                }))}
                value={gh.selectedBranch}
                onChange={gh.selectBranch}
                placeholder={
                  gh.loading === "branches"
                    ? "Loading branches…"
                    : gh.branches.length === 0
                      ? "No branches"
                      : "Select a branch…"
                }
                searchPlaceholder="Search branches…"
                emptyText="No branches match"
                disabled={disabled || gh.loading === "branches"}
              />
            </div>
          )}

          {gh.selectedRepoFullName && gh.selectedBranch && (
            <div className="flex flex-col gap-1">
              <Label className="text-[11px]">Subpath</Label>
              <FolderBrowser
                projectId={projectId}
                owner={gh.selectedRepoFullName.split("/")[0] ?? ""}
                repo={gh.selectedRepoFullName.split("/")[1] ?? ""}
                ref={gh.selectedBranch}
                value={subpath}
                onChange={onSubpathChange}
                disabled={disabled}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Manual Git fields
// ---------------------------------------------------------------------------

interface GitManualFieldsProps {
  repositoryUrl: string;
  gitRef: string;
  subpath: string;
  disabled: boolean;
  onRepositoryUrlChange: (value: string) => void;
  onGitRefChange: (value: string) => void;
  onSubpathChange: (value: string) => void;
}

function GitManualFields({
  repositoryUrl,
  gitRef,
  subpath,
  disabled,
  onRepositoryUrlChange,
  onGitRefChange,
  onSubpathChange,
}: GitManualFieldsProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="task-source-repo-url">Repository URL</Label>
        <Input
          id="task-source-repo-url"
          type="text"
          value={repositoryUrl}
          onChange={(e) => onRepositoryUrlChange(e.target.value)}
          placeholder="https://github.com/owner/repo.git"
          disabled={disabled}
          className="font-mono"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="task-source-git-ref">Branch or ref</Label>
          <Input
            id="task-source-git-ref"
            type="text"
            value={gitRef}
            onChange={(e) => onGitRefChange(e.target.value)}
            placeholder="main"
            disabled={disabled}
            className="font-mono"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="task-source-subpath">Subpath (optional)</Label>
          <Input
            id="task-source-subpath"
            type="text"
            value={subpath}
            onChange={(e) => onSubpathChange(e.target.value)}
            placeholder="e2e/"
            disabled={disabled}
            className="font-mono"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </div>
    </div>
  );
}

function defaultDisplayName(method: Method): string {
  if (method === "filesystem") return "Local filesystem";
  return "Git repository";
}

// ---------------------------------------------------------------------------
// Searchable select (base-ui Combobox — "input inside popup" pattern)
// ---------------------------------------------------------------------------

interface SearchableSelectItem {
  value: string;
  label: string;
}

interface SearchableSelectProps {
  items: SearchableSelectItem[];
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  disabled?: boolean;
}

function SearchableSelect({
  items,
  value,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyText,
  disabled = false,
}: SearchableSelectProps) {
  return (
    <ComboboxPrimitive.Root
      value={value ? items.find((i) => i.value === value) ?? null : null}
      onValueChange={(next) => {
        // base-ui returns the full item object (or null), not the
        // raw value string. Unwrap so callers receive a plain string.
        if (next === null) onChange("");
        else if (typeof next === "string") onChange(next);
        else onChange(next.value);
      }}
      items={items}
      itemToStringLabel={(item: SearchableSelectItem) => item.label}
      disabled={disabled}
    >
      <ComboboxPrimitive.Trigger
        type="button"
        className={cn(
          "flex h-8 w-full items-center justify-between rounded-none border border-foreground/20 bg-card px-2.5 text-xs",
          "data-[placeholder]:text-muted-foreground",
          "transition-colors hover:border-foreground/40 hover:bg-muted/20",
          "focus-visible:border-foreground focus-visible:ring-1 focus-visible:ring-foreground/20",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "font-mono text-left",
        )}
      >
        <ComboboxPrimitive.Value placeholder={placeholder} />
        <ComboboxPrimitive.Icon className="ml-2 size-3.5 shrink-0 text-muted-foreground">
          <ChevronDown />
        </ComboboxPrimitive.Icon>
      </ComboboxPrimitive.Trigger>
      <ComboboxPrimitive.Portal>
        <ComboboxPrimitive.Positioner
          sideOffset={4}
          className="z-50"
          align="start"
        >
          <ComboboxPrimitive.Popup
            className={cn(
              "min-w-[var(--popup-anchor-width)] max-h-72 overflow-hidden rounded-none",
              "bg-popover text-popover-foreground ring-1 ring-foreground/10 shadow-md",
              "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 duration-100",
            )}
          >
            <div className="border-b border-border/60 p-1">
              <ComboboxPrimitive.Input
                placeholder={searchPlaceholder}
                className={cn(
                  "h-8 w-full rounded-none border border-input bg-input/30 px-2 text-xs font-mono",
                  "outline-none placeholder:text-muted-foreground",
                  "focus-visible:border-ring",
                )}
              />
            </div>
            <ComboboxPrimitive.List
              className={cn(
                "max-h-56 overflow-y-auto overscroll-contain py-1",
                "data-empty:p-0",
              )}
            >
              {(item: SearchableSelectItem) => (
                <ComboboxPrimitive.Item
                  key={item.value}
                  value={item}
                  className={cn(
                    "relative flex w-full cursor-default items-center gap-2 py-1.5 pr-8 pl-2 text-xs font-mono",
                    "outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                    "data-highlighted:bg-accent data-highlighted:text-accent-foreground",
                  )}
                >
                  <ComboboxPrimitive.ItemIndicator
                    render={
                      <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
                    }
                  >
                    <Check />
                  </ComboboxPrimitive.ItemIndicator>
                  <span className="truncate">{item.label}</span>
                </ComboboxPrimitive.Item>
              )}
            </ComboboxPrimitive.List>
            <ComboboxPrimitive.Empty
              className="px-2 py-2 text-center text-xs text-muted-foreground"
            >
              {emptyText}
            </ComboboxPrimitive.Empty>
          </ComboboxPrimitive.Popup>
        </ComboboxPrimitive.Positioner>
      </ComboboxPrimitive.Portal>
    </ComboboxPrimitive.Root>
  );
}
