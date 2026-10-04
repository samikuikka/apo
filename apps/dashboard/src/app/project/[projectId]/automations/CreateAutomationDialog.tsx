"use client";

import { useCallback, useMemo, useState } from "react";
import {
  type AutomationActionType,
  type AutomationCondition,
  type AutomationSummary,
  type EvaluationWindow,
  type WindowMetricId,
  type WindowOperator,
  WINDOW_METRIC_LABELS,
  createAutomation,
} from "@/lib/automations-api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  EVENT_TYPES,
  parseConditionValue,
  SELECT_CLASS,
  TRIGGER_CHOICES,
} from "./automation-presets";
import { useRuleDraft } from "./use-rule-draft";
import { TriggerChoices } from "./components/TriggerChoices";
import { AdvancedRuleEditor } from "./components/AdvancedRuleEditor";

interface CreateAutomationDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (automation: AutomationSummary, secret: string | null) => void;
  onError: (message: string | null) => void;
}

// Outcome-first, one question per step. The plain-language triggers map to
// real event/condition pairs; the full vocabulary stays available behind
// the Advanced disclosure so the default path stays minimal.
const OUTCOMES: {
  id: AutomationActionType;
  title: string;
  blurb: string;
}[] = [
  {
    id: "github_issue",
    title: "Open a GitHub issue",
    blurb: "The failure lands next to the harness code, with trace links.",
  },
  {
    id: "slack",
    title: "Post to Slack",
    blurb: "A formatted message in a channel you pick (incoming webhook).",
  },
  {
    id: "webhook",
    title: "Call a webhook",
    blurb: "A signed POST to any endpoint you own.",
  },
];



export default function CreateAutomationDialog({
  projectId,
  open,
  onOpenChange,
  onCreated,
  onError,
}: CreateAutomationDialogProps) {
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [outcome, setOutcome] = useState<AutomationActionType | null>(null);

  const draft = useRuleDraft();
  const {
    trigger,
    taskFilter,
    advancedOpen,
    advancedEvent,
    advancedConditions,
    selectTrigger,
    setTaskFilter,
    patchDraft,
    selectAdvancedEvent,
    updateCondition,
    removeCondition,
    addCondition,
    resetDraft,
    rule,
  } = draft;

  // Local alias so TypeScript's aliased-condition narrowing rules out the
  // empty-event sentinel at the submit sites below.
  const useAdvanced = advancedOpen && advancedEvent !== "";

  // Window ("monitor") triggers: the evaluator watches an aggregate over a
  // time window instead of matching single events.
  const [windowMode, setWindowMode] = useState(false);
  const [windowMetric, setWindowMetric] = useState<WindowMetricId>("suite_pass_rate");
  const [windowOperator, setWindowOperator] = useState<WindowOperator>("lt");
  const [windowThreshold, setWindowThreshold] = useState("80");
  const [windowEval, setWindowEval] = useState<EvaluationWindow>("24h");

  // GitHub action.
  const [githubToken, setGithubToken] = useState("");
  const [repoSearch, setRepoSearch] = useState("");
  const [repos, setRepos] = useState<string[] | null>(null);
  const [repoSearchError, setRepoSearchError] = useState<string | null>(null);
  const [repoOwner, setRepoOwner] = useState("");
  const [repoName, setRepoName] = useState("");

  // Webhook action.
  const [url, setUrl] = useState("");

  const [submitting, setSubmitting] = useState(false);

  const triggerLabel = TRIGGER_CHOICES.find((t) => t.id === trigger)?.label ?? "";

  const reset = useCallback(() => {
    setStep(0);
    setOutcome(null);
    resetDraft();
    setWindowMode(false);
    setWindowMetric("suite_pass_rate");
    setWindowOperator("lt");
    setWindowThreshold("80");
    setWindowEval("24h");
    setGithubToken("");
    setRepoSearch("");
    setRepos(null);
    setRepoSearchError(null);
    setRepoOwner("");
    setRepoName("");
    setUrl("");
  }, [resetDraft]);

  const searchRepos = useCallback(async () => {
    setRepoSearchError(null);
    try {
      // GitHub's API allows browser CORS, so the pasted token can list the
      // user's own repositories directly — no server round-trip needed.
      const res = await fetch(
        "https://api.github.com/user/repos?per_page=100&sort=updated",
        {
          headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: "application/vnd.github+json",
          },
        },
      );
      if (!res.ok) {
        setRepos(null);
        setRepoSearchError(
          res.status === 401
            ? "That token was rejected — check it has repo read access."
            : `GitHub returned ${res.status}. You can still enter the repository manually.`,
        );
        return;
      }
      const data: unknown = await res.json();
      if (Array.isArray(data)) {
        setRepos(
          data
            .map((repo) =>
              typeof (repo as { full_name?: unknown }).full_name === "string"
                ? (repo as { full_name: string }).full_name
                : "",
            )
            .filter(Boolean),
        );
      }
    } catch {
      setRepos(null);
      setRepoSearchError(
        "Could not reach GitHub — you can still enter the repository manually.",
      );
    }
  }, [githubToken]);

  const filteredRepos = useMemo(() => {
    if (repos === null) return [];
    const q = repoSearch.trim().toLowerCase();
    if (!q) return repos.slice(0, 8);
    return repos.filter((r) => r.toLowerCase().includes(q)).slice(0, 8);
  }, [repos, repoSearch]);

  const canSubmit = useMemo(() => {
    if (submitting) return false;
    if (outcome === "slack") {
      return url.trim().startsWith("https://hooks.slack.com/services/");
    }
    if (outcome === "webhook") return url.trim().length > 0;
    if (outcome === "github_issue") {
      return (
        githubToken.trim().length > 0 &&
        repoOwner.trim().length > 0 &&
        repoName.trim().length > 0
      );
    }
    return false;
  }, [githubToken, outcome, repoName, repoOwner, submitting, url]);

  const handleSubmit = useCallback(async () => {
    if (outcome === null) return;
    setSubmitting(true);
    onError(null);
    try {
      if (windowMode) {
        const thresholdNumber =
          windowMetric === "suite_pass_rate" ||
          windowMetric === "checks_pass_rate" ||
          windowMetric === "error_rate"
            ? Number(windowThreshold) / 100
            : Number(windowThreshold);
        if (!Number.isFinite(thresholdNumber)) {
          onError("Threshold must be a number");
          setSubmitting(false);
          return;
        }
        const created = await createAutomation({
          project_id: projectId,
          name: `${WINDOW_METRIC_LABELS[windowMetric]} ${
            windowOperator === "lt" ? "below" : "above"
          } ${windowThreshold} over ${windowEval} → ${
            outcome === "github_issue" ? "GitHub issue" : outcome === "slack" ? "Slack" : "webhook"
          }`,
          trigger_kind: "window",
          conditions: [],
          window_metric: windowMetric,
          window_operator: windowOperator,
          window_threshold: thresholdNumber,
          evaluation_window: windowEval,
          action_type: outcome,
          action_config:
            outcome === "webhook" || outcome === "slack"
              ? { url: url.trim() }
              : {
                  owner: repoOwner.trim(),
                  repo: repoName.trim(),
                  labels: null,
                  title: null,
                  body: null,
                },
          github_token: outcome === "github_issue" ? githubToken.trim() : undefined,
        });
        onCreated(created, created.secret ?? null);
        reset();
        onOpenChange(false);
        return;
      }
      const event = useAdvanced ? advancedEvent : rule.event;
      const conditions: AutomationCondition[] = useAdvanced
        ? advancedConditions.map((condition) => ({
            field: condition.field,
            operator: condition.operator,
            value: parseConditionValue(condition.value),
          }))
        : rule.conditions;
      const created = await createAutomation({
        project_id: projectId,
        name:
          useAdvanced || trigger === "task"
            ? `${EVENT_TYPES.find((e) => e.value === event)?.label ?? event} → ${
                outcome === "github_issue" ? "GitHub issue" : outcome === "slack" ? "Slack" : "webhook"
              }`
            : `${triggerLabel} → ${outcome === "github_issue" ? "GitHub issue" : outcome === "slack" ? "Slack" : "webhook"}`,
        event_type: event,
        conditions,
        action_type: outcome,
        action_config:
          outcome === "webhook" || outcome === "slack"
            ? { url: url.trim() }
            : {
                owner: repoOwner.trim(),
                repo: repoName.trim(),
                labels: null,
                title: null,
                body: null,
              },
        github_token: outcome === "github_issue" ? githubToken.trim() : undefined,
      });
      onCreated(created, created.secret ?? null);
      reset();
      onOpenChange(false);
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : "Failed to create automation");
    } finally {
      setSubmitting(false);
    }
  }, [
    advancedConditions,
    advancedEvent,
    githubToken,
    onError,
    onCreated,
    onOpenChange,
    outcome,
    projectId,
    repoName,
    repoOwner,
    reset,
    rule,
    trigger,
    triggerLabel,
    url,
    useAdvanced,
    windowEval,
    windowMetric,
    windowMode,
    windowOperator,
    windowThreshold,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {step === 0
              ? "New Automation"
              : step === 1
                ? "When exactly?"
                : outcome === "github_issue"
                  ? "Which repository?"
                  : outcome === "slack"
                    ? "Which Slack channel?"
                    : "Where should we POST?"}
          </DialogTitle>
          <DialogDescription>
            {step === 0
              ? "What should happen when a run fails?"
              : step === 1
                ? "Pick the runs this applies to."
                : outcome === "github_issue"
                  ? "Last step — where the issue lands."
                  : outcome === "slack"
                    ? "Last step — the channel's incoming-webhook URL."
                    : "Last step — the destination."}
          </DialogDescription>
        </DialogHeader>

        {step === 0 ? (
          <div className="flex flex-col gap-3">
            {OUTCOMES.map((choice) => (
              <button
                key={choice.id}
                type="button"
                className="border border-border bg-background p-4 text-left transition-colors hover:border-foreground/40"
                onClick={() => {
                  setOutcome(choice.id);
                  setStep(1);
                }}
              >
                <p className="text-sm font-medium">{choice.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {choice.blurb}
                </p>
              </button>
            ))}
          </div>
        ) : null}

        {step === 1 ? (
          <div className="flex flex-col gap-2">
            <TriggerChoices
              trigger={trigger}
              taskFilter={taskFilter}
              useAdvanced={useAdvanced}
              onSelectTrigger={(next) => {
                selectTrigger(next);
                setWindowMode(false);
              }}
              onTaskFilterChange={setTaskFilter}
            />

            <div className="mt-3 border-t border-border pt-3">
              <p className="text-xs font-semibold text-muted-foreground">
                Or watch a window — an aggregate over recent runs
              </p>
              <button
                type="button"
                aria-pressed={windowMode}
                className={`mt-2 w-full border p-3 text-left text-sm transition-colors ${
                  windowMode
                    ? "border-foreground bg-muted/30"
                    : "border-border bg-background hover:border-foreground/40"
                }`}
                onClick={() => setWindowMode(!windowMode)}
              >
                When
                <select
                  aria-label="Window metric"
                  className={`${SELECT_CLASS} mx-1`}
                  value={windowMetric}
                  onChange={(e) => {
                    setWindowMetric(e.target.value as WindowMetricId);
                    setWindowOperator(
                      e.target.value === "suite_pass_rate" ||
                        e.target.value === "checks_pass_rate" ||
                        e.target.value === "error_rate"
                        ? "lt"
                        : "gt",
                    );
                    setWindowThreshold(
                      e.target.value === "suite_pass_rate" ||
                        e.target.value === "checks_pass_rate"
                        ? "80"
                        : e.target.value === "error_rate"
                          ? "5"
                          : e.target.value.endsWith("_cost")
                            ? "5"
                            : "300",
                    );
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {Object.entries(WINDOW_METRIC_LABELS).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
                is
                <select
                  aria-label="Window operator"
                  className={`${SELECT_CLASS} mx-1`}
                  value={windowOperator}
                  onChange={(e) =>
                    setWindowOperator(e.target.value as WindowOperator)
                  }
                  onClick={(e) => e.stopPropagation()}
                >
                  <option value="lt">below</option>
                  <option value="gt">above</option>
                  <option value="gte">at least</option>
                </select>
                <Input
                  aria-label="Window threshold"
                  className="mx-1 inline-block h-8 w-20 font-mono text-xs tabular-nums"
                  value={windowThreshold}
                  onChange={(e) => setWindowThreshold(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
                over
                <select
                  aria-label="Evaluation window"
                  className={`${SELECT_CLASS} mx-1`}
                  value={windowEval}
                  onChange={(e) => setWindowEval(e.target.value as EvaluationWindow)}
                  onClick={(e) => e.stopPropagation()}
                >
                  <option value="1h">1h</option>
                  <option value="6h">6h</option>
                  <option value="24h">24h</option>
                  <option value="7d">7d</option>
                </select>
                <span className="mt-1 block text-xs text-muted-foreground">
                  The evaluator re-checks every 5 minutes and fires once when
                  the threshold is crossed.
                </span>
              </button>
            </div>

            <div className="mt-3 border-t border-border pt-3">
              <button
                type="button"
                className="text-xs text-muted-foreground underline hover:text-foreground"
                onClick={() => patchDraft({ advancedOpen: !advancedOpen })}
                aria-expanded={advancedOpen}
              >
                {advancedOpen ? "Hide" : "Advanced"} — pick the raw event and
                conditions
              </button>
              {advancedOpen ? (
                <div className="mt-3 flex flex-col gap-2">
                  <AdvancedRuleEditor
                    event={advancedEvent}
                    conditions={advancedConditions}
                    onSelectEvent={selectAdvancedEvent}
                    onUpdateCondition={updateCondition}
                    onRemoveCondition={removeCondition}
                    onAddCondition={addCondition}
                    valuePlaceholder="false, schedule, 2…"
                  />
                </div>
              ) : null}
            </div>

            <div className="mt-4 flex gap-2">
              <Button
                type="button"
                size="sm"
                className="h-8"
                disabled={useAdvanced ? false : trigger === "task" && !taskFilter.trim()}
                onClick={() => setStep(2)}
              >
                Next
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => setStep(0)}
              >
                Back
              </Button>
            </div>
          </div>
        ) : null}

        {step === 2 && outcome === "github_issue" ? (
          <div className="flex flex-col gap-3 text-xs">
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">
                GitHub token — encrypted at rest, only needed once
              </span>
              <div className="flex gap-2">
                <Input
                  type="password"
                  aria-label="GitHub token"
                  className="h-8 flex-1 text-xs"
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  placeholder="ghp_… (needs issues:write)"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={!githubToken.trim()}
                  onClick={searchRepos}
                >
                  Find My Repositories
                </Button>
              </div>
            </label>

            {repos !== null ? (
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground">Repository</span>
                <Input
                  aria-label="Filter repositories"
                  className="h-8 text-xs"
                  value={repoSearch}
                  onChange={(e) => setRepoSearch(e.target.value)}
                  placeholder="Filter your repositories…"
                />
                <div className="mt-1 flex max-h-32 flex-col gap-1 overflow-y-auto">
                  {filteredRepos.map((full) => {
                    const [owner, name] = full.split("/");
                    return (
                      <button
                        key={full}
                        type="button"
                        className={`border px-2 py-1.5 text-left font-mono ${
                          repoOwner === owner && repoName === name
                            ? "border-foreground bg-muted/30"
                            : "border-border hover:border-foreground/40"
                        }`}
                        onClick={() => {
                          setRepoOwner(owner);
                          setRepoName(name);
                        }}
                      >
                        {full}
                      </button>
                    );
                  })}
                  {filteredRepos.length === 0 ? (
                    <span className="px-1 text-muted-foreground">
                      No repository matches.
                    </span>
                  ) : null}
                </div>
              </label>
            ) : null}
            {repoSearchError ? (
              <p className="text-muted-foreground">{repoSearchError}</p>
            ) : null}

            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground">Owner</span>
                <Input
                  aria-label="Repository owner"
                  className="h-8 text-xs"
                  value={repoOwner}
                  onChange={(e) => setRepoOwner(e.target.value)}
                  placeholder="acme"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground">Repository</span>
                <Input
                  aria-label="Repository name"
                  className="h-8 text-xs"
                  value={repoName}
                  onChange={(e) => setRepoName(e.target.value)}
                  placeholder="agent-harness"
                />
              </label>
            </div>

            <div className="border border-border bg-muted/20 p-3 font-mono text-xs">
              <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                The issue that will open
              </p>
              <p className="font-medium">
                apo: nightly-batch — 2 of 3 tasks failed
              </p>
              <p className="mt-1 text-muted-foreground">
                | Batch | Trigger | Result | Failing tasks |
              </p>
              <p className="text-muted-foreground">
                data-extraction · summarize-output → traces ↗
              </p>
            </div>

            <div className="mt-1 flex gap-2">
              <Button
                type="button"
                size="sm"
                className="h-8"
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                {submitting ? "Creating…" : "Create Automation"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => setStep(1)}
              >
                Back
              </Button>
            </div>
          </div>
        ) : null}

        {step === 2 && outcome === "slack" ? (
          <div className="flex flex-col gap-3 text-xs">
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">Slack webhook URL</span>
              <Input
                aria-label="Slack webhook URL"
                className="h-8 text-xs"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://hooks.slack.com/services/…"
              />
              <span className="text-muted-foreground">
                In Slack: channel → Integrations → Incoming webhooks. The URL
                is stored encrypted; only a masked tail is ever shown again.
              </span>
            </label>
            <div className="border border-border bg-muted/20 p-3 font-mono text-xs">
              <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                The message that will post
              </p>
              <p className="font-medium">Batch failed — 2 of 3 tasks failed</p>
              <p className="mt-1 text-muted-foreground">
                Project · Batch · Trigger · Duration
              </p>
              <p className="text-muted-foreground">
                • data-extraction — 1/4 checks · trace ↗
              </p>
            </div>
            <div className="mt-1 flex gap-2">
              <Button
                type="button"
                size="sm"
                className="h-8"
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                {submitting ? "Creating…" : "Create Automation"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => setStep(1)}
              >
                Back
              </Button>
            </div>
          </div>
        ) : null}

        {step === 2 && outcome === "webhook" ? (
          <div className="flex flex-col gap-3 text-xs">
            <label className="flex flex-col gap-1">
              <span className="text-muted-foreground">Webhook URL</span>
              <Input
                aria-label="Webhook URL"
                className="h-8 text-xs"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://…"
              />
              <span className="text-muted-foreground">
                Deliveries are HMAC-signed; the secret is shown once after
                creating. Test it right after from the rule&apos;s Test button.
              </span>
            </label>
            <div className="mt-1 flex gap-2">
              <Button
                type="button"
                size="sm"
                className="h-8"
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                {submitting ? "Creating…" : "Create Automation"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => setStep(1)}
              >
                Back
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
