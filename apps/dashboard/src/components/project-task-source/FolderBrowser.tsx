"use client";

import { useEffect, useState } from "react";
import { ChevronRight, Folder, FolderOpen, Loader2, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { listRepoContents, type GithubPathEntry } from "@/lib/github-api";

interface FolderBrowserProps {
  projectId: string;
  owner: string;
  repo: string;
  ref: string;
  /** Currently selected subpath. */
  value: string;
  onChange: (path: string) => void;
  disabled?: boolean;
}

interface Crumb {
  name: string;
  path: string;
}

/**
 * Two-pane folder navigator for picking a subpath inside a GitHub repo.
 * The user clicks through directories; the current folder can be picked
 * as the subpath via the "Use this folder" button.
 *
 * Hits GitHub's contents API via the backend's project-scoped route —
 * no clone required.
 */
export function FolderBrowser({
  projectId,
  owner,
  repo,
  ref,
  value,
  onChange,
  disabled = false,
}: FolderBrowserProps) {
  // Path the user is currently *browsing* (not yet committed as the
  // subpath). Defaults to the currently-selected subpath so the user
  // lands where they left off.
  const [browsePath, setBrowsePath] = useState<string>(value || "");
  const [entries, setEntries] = useState<GithubPathEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listRepoContents(projectId, owner, repo, ref, browsePath)
      .then((rows) => {
        if (cancelled) return;
        setEntries(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Failed to load folder.",
        );
        setEntries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, owner, repo, ref, browsePath]);

  const crumbs = buildCrumbs(browsePath);
  const folders = entries.filter((e) => e.type === "dir");
  const files = entries.filter((e) => e.type !== "dir");
  const isCurrentValue = value === browsePath || (!value && browsePath === "");

  function openFolder(entry: GithubPathEntry) {
    setBrowsePath(entry.path);
  }

  function navigateTo(path: string) {
    setBrowsePath(path);
  }

  function handleUseCurrentFolder() {
    onChange(browsePath);
  }

  return (
    <div className="flex flex-col gap-2 border border-foreground/20 bg-card p-2">
      {/* Breadcrumb */}
      <div className="flex flex-wrap items-center gap-0.5 text-[11px] text-muted-foreground">
        <button
          type="button"
          onClick={() => navigateTo("")}
          className={cn(
            "px-1 py-0.5 hover:bg-muted/40 hover:text-foreground",
            browsePath === "" && "text-foreground",
          )}
        >
          {owner}/{repo}
        </button>
        {crumbs.map((crumb) => (
          <span key={crumb.path} className="flex items-center">
            <ChevronRight className="size-3 text-muted-foreground/50" />
            <button
              type="button"
              onClick={() => navigateTo(crumb.path)}
              className={cn(
                "px-1 py-0.5 hover:bg-muted/40 hover:text-foreground",
                crumb.path === browsePath && "text-foreground",
              )}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </div>

      {/* Folder list */}
      <div className="flex min-h-[80px] flex-col gap-0.5">
        {loading ? (
          <div className="flex items-center gap-1.5 py-3 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Loading…
          </div>
        ) : error ? (
          <div className="py-3 text-[11px] text-destructive">{error}</div>
        ) : folders.length === 0 && files.length === 0 ? (
          <div className="py-3 text-[11px] text-muted-foreground">
            Empty folder.
          </div>
        ) : (
          <>
            {folders.map((entry) => (
              <button
                key={entry.path}
                type="button"
                onClick={() => openFolder(entry)}
                disabled={disabled}
                className={cn(
                  "flex items-center gap-1.5 px-1.5 py-1 text-left text-[11px]",
                  "hover:bg-muted/40 hover:text-foreground",
                  "font-mono",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                {browsePath.startsWith(entry.path + "/") ||
                browsePath === entry.path ? (
                  <FolderOpen className="size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <Folder className="size-3 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
            {files.length > 0 && (
              <>
                <div className="mt-1 px-1.5 text-[10px] uppercase tracking-wide text-muted-foreground/60">
                  {files.length} file{files.length === 1 ? "" : "s"} (hidden)
                </div>
                {files.some((f) => f.name.endsWith(".eval.ts") || f.name === "task.ts") && (
                  <div className="px-1.5 py-0.5 text-[10px] text-success">
                    ✓ task definition found in this folder
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* Action */}
      <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-2">
        <span className="font-mono text-[10px] text-muted-foreground">
          {browsePath ? `subpath: ${browsePath}` : "subpath: (repo root)"}
        </span>
        <Button
          type="button"
          variant={isCurrentValue ? "secondary" : "default"}
          size="xs"
          onClick={handleUseCurrentFolder}
          disabled={disabled || isCurrentValue}
        >
          {isCurrentValue ? (
            <>
              <Check className="size-3" />
              Selected
            </>
          ) : (
            "Use this folder"
          )}
        </Button>
      </div>
    </div>
  );
}

function buildCrumbs(path: string): Crumb[] {
  if (!path) return [];
  const parts = path.split("/").filter(Boolean);
  const crumbs: Crumb[] = [];
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    crumbs.push({ name: part, path: acc });
  }
  return crumbs;
}
