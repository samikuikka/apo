"use client";

import { useEffect, useState } from "react";

import {
  getConnectedExecutorStatus,
  type ConnectedEnvironmentState,
} from "@/lib/agent-task-api";

const POLL_MS = 15_000;
/** A hung request must not hold the in-flight guard and stop polling. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface ExecutorRunWarning {
  /** The strip's short state, e.g. "Not connected". */
  label: string;
  /** The inline fix shown after the state, e.g. "run apo connect". */
  fix: string;
  /** The Why? disclosure: full sentences, including the queue expiry. */
  detail: string;
}

/**
 * Why a dashboard run would sit in the queue, or null when an Executor will
 * claim it. Dashboard Batches target the member's own Connected Executors, so
 * a teammate's `apo connect` does not help; the copy says "your". The strip
 * carries only the state and the fix — the queue-expiry sentence is one-time
 * education and lives behind the Why? disclosure.
 */
export function executorRunWarning(
  state: ConnectedEnvironmentState | null,
): ExecutorRunWarning | null {
  // Mirrors the backend's DEFAULT_QUEUE_TTL_SECONDS (services/executor_auth.py).
  const expiry = "Runs wait in the queue and expire after 24 hours if nothing claims them.";
  switch (state) {
    case "not_connected":
      return {
        label: "Not connected",
        fix: "run apo connect",
        detail: `Run apo connect in this Task workspace to execute dashboard runs. ${expiry}`,
      };
    case "offline":
      return {
        label: "Offline",
        fix: "restart apo connect",
        detail: `Start apo connect again in this Task workspace. ${expiry}`,
      };
    case "incompatible":
      return {
        label: "CLI outdated",
        fix: "update, then reconnect",
        detail: `Update the Apo CLI, then restart apo connect. Queued work starts when compatible; ${expiry.toLowerCase()}`,
      };
    case "catalog_mismatch":
      // The tasks page only renders with a published catalog, so a mismatch
      // means the two differ; either side may be the newer one.
      return {
        label: "Catalog mismatch",
        fix: "publish or pull your tasks",
        detail: `Pull the latest tasks, or run apo task publish if your copy is newer; apo connect resumes automatically. ${expiry}`,
      };
    default:
      return null;
  }
}

/** Polls the member's Connected Executor state; null until known or on error. */
export function useConnectedExecutorState(
  projectId: string,
  enabled: boolean,
): ConnectedEnvironmentState | null {
  const [state, setState] = useState<ConnectedEnvironmentState | null>(null);

  useEffect(() => {
    // A previous selection or project's answer must not flash while reloading.
    setState(null);
    if (!enabled) return;
    let cancelled = false;
    let inFlight: AbortController | null = null;
    // The cleanup must be able to disarm the abort timer even while a
    // request is still pending, so the handle lives at effect scope.
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      if (inFlight || document.hidden) return;
      const controller = new AbortController();
      inFlight = controller;
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      getConnectedExecutorStatus(projectId, controller.signal)
        .then((res) => {
          if (!cancelled) setState(res.state);
        })
        .catch(() => {
          // Status is advisory: an unreachable endpoint must not warn or
          // block, and a transient failure keeps the last known state
          // instead of flashing the warning off and back on.
        })
        .finally(() => {
          if (timeout) clearTimeout(timeout);
          if (inFlight === controller) inFlight = null;
        });
    };
    const onVisibility = () => {
      if (!document.hidden) load();
    };
    load();
    const timer = setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(timer);
      if (timeout) clearTimeout(timeout);
      inFlight?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [projectId, enabled]);

  return state;
}
