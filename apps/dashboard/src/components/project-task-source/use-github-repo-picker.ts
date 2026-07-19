"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import {
  type GithubAvailability,
  type GithubBranch,
  type GithubConnection,
  type GithubRepo,
  disconnectGithub,
  getGithubAuthUrl,
  getGithubConnection,
  listGithubBranches,
  listGithubRepos,
} from "@/lib/github-api";
import type { ProjectTaskSource } from "@/lib/projects-api";

export type GithubLoading = "repos" | "branches" | "connect" | null;

/**
 * Combined state for the repos → branches fetch cascade and selection.
 *
 * Kept in a single ``useReducer`` so each async step publishes ONE action
 * that updates every related field atomically. This avoids chained
 * ``setState`` calls (which produce stale-read cascades across renders) and
 * keeps the pick callbacks — fired outside the dispatch — in sync with the
 * exact values just committed to state.
 */
interface GithubPickerState {
  repos: GithubRepo[];
  branches: GithubBranch[];
  selectedRepoFullName: string;
  selectedBranch: string;
  loading: GithubLoading;
  error: string | null;
}

type GithubPickerAction =
  | { type: "LOAD_REPOS" }
  | {
      type: "REPOS_LOADED";
      repos: GithubRepo[];
      selectedRepoFullName?: string;
      selectedBranch?: string;
    }
  | { type: "LOAD_BRANCHES" }
  | {
      type: "BRANCHES_LOADED";
      branches: GithubBranch[];
      selectedBranch?: string;
    }
  | { type: "ERROR"; error: string }
  | { type: "SET_REPO"; repoFullName: string }
  | { type: "SET_BRANCH"; branch: string }
  | { type: "START_CONNECT" }
  | { type: "RESET" };

const initialState: GithubPickerState = {
  repos: [],
  branches: [],
  selectedRepoFullName: "",
  selectedBranch: "",
  loading: null,
  error: null,
};

function githubPickerReducer(
  state: GithubPickerState,
  action: GithubPickerAction,
): GithubPickerState {
  switch (action.type) {
    case "LOAD_REPOS":
      return { ...state, loading: "repos" };
    case "REPOS_LOADED":
      return {
        ...state,
        repos: action.repos,
        selectedRepoFullName:
          action.selectedRepoFullName ?? state.selectedRepoFullName,
        selectedBranch: action.selectedBranch ?? state.selectedBranch,
        loading: null,
      };
    case "LOAD_BRANCHES":
      return { ...state, loading: "branches" };
    case "BRANCHES_LOADED":
      return {
        ...state,
        branches: action.branches,
        selectedBranch: action.selectedBranch ?? state.selectedBranch,
        loading: null,
      };
    case "ERROR":
      return { ...state, error: action.error, loading: null };
    case "SET_REPO":
      return {
        ...state,
        selectedRepoFullName: action.repoFullName,
        branches: [],
        selectedBranch: "",
      };
    case "SET_BRANCH":
      return { ...state, selectedBranch: action.branch };
    case "START_CONNECT":
      return { ...state, loading: "connect", error: null };
    case "RESET":
      return {
        ...state,
        repos: [],
        branches: [],
        selectedRepoFullName: "",
        selectedBranch: "",
      };
    default:
      return state;
  }
}

interface UseGithubRepoPickerOptions {
  /** Called when a repo is picked (or pre-selected from initialValue). */
  onPickRepo: (repo: GithubRepo) => void;
  /** Called when a branch is picked (or pre-selected). */
  onPickBranch: (branch: string) => void;
}

/**
 * Owns the GitHub connection → repos → branches fetch cascade and the
 * selection state for the task-source form.
 *
 * Extracted from ``GithubConnectSection`` so the component is purely
 * presentational and the cascade lives in one cohesive, testable unit.
 * The previous component interleaved three ``useEffect``s (each with an
 * ``eslint-disable exhaustive-deps``) and synced its selection back into
 * the parent via callbacks fired from inside the effects. Here the
 * callbacks are held in a ref so the fetch effects depend only on the
 * data they actually need — no dependency-list suppression.
 */
export function useGithubRepoPicker(
  projectId: string,
  availability: GithubAvailability | null,
  initialValue: ProjectTaskSource | null,
  { onPickRepo, onPickBranch }: UseGithubRepoPickerOptions,
) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // The GitHub connection is a separate concern from the repos/branches
  // cascade, so it stays in its own useState.
  const [connection, setConnection] = useState<GithubConnection | null>(null);

  const [state, dispatch] = useReducer(githubPickerReducer, initialState);
  const {
    repos,
    branches,
    selectedRepoFullName,
    selectedBranch,
    loading,
    error,
  } = state;

  // Hold the pick callbacks in a ref so the fetch effects below don't have
  // to list them as dependencies (they're stable in intent but not identity),
  // and don't need eslint-disable to say so. Written via useEffect (not in the
  // render body) so render stays pure.
  const pickRef = useRef({ onPickRepo, onPickBranch });
  useEffect(() => {
    pickRef.current = { onPickRepo, onPickBranch };
  });
  // initialValue is read only to pre-select an existing source's repo/branch;
  // capture it once so repo-fetching doesn't re-run when the parent re-renders.
  const initialValueRef = useRef(initialValue);
  useEffect(() => {
    initialValueRef.current = initialValue;
  });

  const ready = availability !== null;
  const available = availability?.enabled === true;

  // Surface OAuth redirect errors (?github_error=...) once.
  useEffect(() => {
    const err = searchParams.get("github_error");
    if (!err) return;
    const description = searchParams.get("github_error_description");
    dispatch({
      type: "ERROR",
      error: description
        ? `GitHub connect failed: ${description}`
        : `GitHub connect failed (${err}).`,
    });
  }, [searchParams]);

  // Load the current connection once availability is confirmed enabled.
  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    getGithubConnection(projectId)
      .then((conn) => {
        if (!cancelled) setConnection(conn);
      })
      .catch(() => {
        // leave connection null — user can still try to connect.
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, available]);

  // When connected, fetch repos and pre-select the repo matching the
  // existing source (if any).
  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    dispatch({ type: "LOAD_REPOS" });
    listGithubRepos(projectId)
      .then((rows) => {
        if (cancelled) return;
        // Pre-compute the selection so we publish repos and the
        // auto-selected repo/branch in a single atomic update.
        const initialUrl = initialValueRef.current?.repository_url ?? "";
        const matched = initialUrl
          ? rows.find((r) => r.clone_url === initialUrl)
          : null;
        const branch = matched
          ? initialValueRef.current?.git_ref ?? matched.default_branch
          : undefined;
        dispatch({
          type: "REPOS_LOADED",
          repos: rows,
          selectedRepoFullName: matched?.full_name,
          selectedBranch: branch,
        });
        if (matched) {
          pickRef.current.onPickRepo(matched);
          if (branch) pickRef.current.onPickBranch(branch);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          dispatch({
            type: "ERROR",
            error:
              err instanceof Error ? err.message : "Failed to load GitHub repos.",
          });
        }
      });
  }, [connection, projectId]);

  // Load branches whenever the selected repo changes.
  useEffect(() => {
    if (!connection || !selectedRepoFullName) return;
    const [owner, repoName] = selectedRepoFullName.split("/");
    if (!owner || !repoName) return;
    let cancelled = false;
    dispatch({ type: "LOAD_BRANCHES" });
    listGithubBranches(projectId, owner, repoName)
      .then((rows) => {
        if (cancelled) return;
        // Pre-compute the target branch so the selection publishes in the
        // same atomic update as the loaded branches.
        const matched = repos.find((r) => r.full_name === selectedRepoFullName);
        const defaultBranch = matched?.default_branch;
        const initial = initialValueRef.current?.git_ref;
        const target =
          (initial && rows.find((b) => b.name === initial)?.name) ||
          defaultBranch ||
          rows[0]?.name ||
          "";
        dispatch({
          type: "BRANCHES_LOADED",
          branches: rows,
          selectedBranch: target || undefined,
        });
        if (target) pickRef.current.onPickBranch(target);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          dispatch({
            type: "ERROR",
            error:
              err instanceof Error ? err.message : "Failed to load branches.",
          });
        }
      });
  }, [connection, projectId, selectedRepoFullName, repos]);

  async function connect() {
    dispatch({ type: "START_CONNECT" });
    try {
      const next = window.location.pathname + window.location.search;
      const { url } = await getGithubAuthUrl(projectId, next);
      window.location.href = url;
    } catch (err: unknown) {
      dispatch({
        type: "ERROR",
        error:
          err instanceof Error ? err.message : "Failed to start GitHub OAuth.",
      });
    }
  }

  async function disconnect() {
    try {
      await disconnectGithub(projectId);
      setConnection(null);
      dispatch({ type: "RESET" });
      toast.success("GitHub disconnected");
      router.refresh();
    } catch (err: unknown) {
      dispatch({
        type: "ERROR",
        error:
          err instanceof Error ? err.message : "Failed to disconnect GitHub.",
      });
    }
  }

  function selectRepo(fullName: string) {
    dispatch({ type: "SET_REPO", repoFullName: fullName });
    const next = repos.find((r) => r.full_name === fullName);
    if (next) pickRef.current.onPickRepo(next);
  }

  function selectBranch(name: string) {
    dispatch({ type: "SET_BRANCH", branch: name });
    if (name) pickRef.current.onPickBranch(name);
  }

  return {
    ready,
    available,
    connection,
    repos,
    branches,
    selectedRepoFullName,
    selectedBranch,
    loading,
    error,
    connect,
    disconnect,
    selectRepo,
    selectBranch,
  };
}
