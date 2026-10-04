"use client";

import { useCallback, useMemo, useState } from "react";
import {
  type AutomationSummary,
  type EvaluationWindow,
  type WindowMetricId,
  type WindowOperator,
  WINDOW_METRIC_LABELS,
  formatWindowValue,
  updateAutomation,
} from "@/lib/automations-api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  parseConditionValue,
  ruleFromAutomation,
  SELECT_CLASS,
  stringifyConditionValue,
} from "./automation-presets";
import { useRuleDraft } from "./use-rule-draft";
import { TriggerChoices } from "./components/TriggerChoices";
import { AdvancedRuleEditor } from "./components/AdvancedRuleEditor";

interface EditAutomationDialogProps {
  automation: AutomationSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: (automation: AutomationSummary) => void;
  onError: (message: string | null) => void;
}

// Edit mirrors the create wizard's questions with current values pre-filled
// (trigger + action config now share the same components and rule-draft
// hook). The action type is immutable (delete + recreate to switch); the
// GitHub token field starts empty and stays empty to keep the stored
// token — the same masked-keep semantics as rotation.
export default function EditAutomationDialog({
  automation,
  open,
  onOpenChange,
  onUpdated,
  onError,
}: EditAutomationDialogProps) {
  const source = useMemo(() => ruleFromAutomation(automation), [automation]);

  const [name, setName] = useState(automation.name);
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
    rule,
  } = useRuleDraft(
    source.mode === "advanced"
      ? {
          advancedOpen: true,
          advancedEvent: source.event,
          advancedConditions: source.conditions,
        }
      : {
          trigger: source.mode === "preset" ? source.trigger : "scheduled",
          taskFilter: source.mode === "preset" ? source.taskFilter : "",
        },
  );

  // Local alias so TypeScript's aliased-condition narrowing rules out the
  // empty-event sentinel at the submit sites below.
  const useAdvanced = advancedOpen && advancedEvent !== "";

  const isUrlAction =
    automation.action_type === "webhook" || automation.action_type === "slack";
  const initialUrl = isUrlAction
    ? automation.action_type === "slack"
      ? "" // Slack's URL is secret — replace-only, like the GitHub token
      : String(automation.action_config.url ?? "")
    : "";
  const [url, setUrl] = useState(initialUrl);
  const repoOwner =
    automation.action_type === "github_issue"
      ? String(automation.action_config.owner ?? "")
      : "";
  const repoName =
    automation.action_type === "github_issue"
      ? String(automation.action_config.repo ?? "")
      : "";
  const [owner, setOwner] = useState(repoOwner);
  const [repo, setRepo] = useState(repoName);
  const [githubToken, setGithubToken] = useState("");

  const [submitting, setSubmitting] = useState(false);

  // Window automations edit their trigger knobs instead of event/conditions.
  const isWindow = automation.trigger_kind === "window";
  const percentMetric =
    automation.window_metric === "suite_pass_rate" ||
    automation.window_metric === "checks_pass_rate" ||
    automation.window_metric === "error_rate";
  const [windowMetric, setWindowMetric] = useState<WindowMetricId>(
    automation.window_metric ?? "suite_pass_rate",
  );
  const [windowOperator, setWindowOperator] = useState<WindowOperator>(
    automation.window_operator ?? "lt",
  );
  const [windowThreshold, setWindowThreshold] = useState(() =>
    percentMetric
      ? String(Math.round((automation.window_threshold ?? 80) * 100))
      : String(automation.window_threshold ?? 1),
  );
  const [windowEval, setWindowEval] = useState<EvaluationWindow>(
    automation.evaluation_window ?? "24h",
  );

  const canSubmit = useMemo(() => {
    if (submitting || !name.trim()) return false;
    if (advancedOpen && advancedEvent === "") return false;
    if (!useAdvanced && trigger === "task" && !taskFilter.trim()) return false;
    if (automation.action_type === "slack") {
      // empty keeps the stored URL; otherwise it must be a Slack webhook URL
      return (
        url.trim() === "" ||
        url.trim().startsWith("https://hooks.slack.com/services/")
      );
    }
    if (automation.action_type === "webhook") return url.trim().length > 0;
    return owner.trim().length > 0 && repo.trim().length > 0;
  }, [
    advancedEvent,
    advancedOpen,
    automation.action_type,
    name,
    owner,
    repo,
    submitting,
    taskFilter,
    trigger,
    url,
    useAdvanced,
  ]);

  const handleSubmit = useCallback(async () => {
    setSubmitting(true);
    onError(null);
    try {
      if (isWindow) {
        const nextPercent =
          windowMetric === "suite_pass_rate" ||
          windowMetric === "checks_pass_rate" ||
          windowMetric === "error_rate";
        const thresholdNumber = nextPercent
          ? Number(windowThreshold) / 100
          : Number(windowThreshold);
        if (!Number.isFinite(thresholdNumber)) {
          onError("Threshold must be a number");
          setSubmitting(false);
          return;
        }
        const updated = await updateAutomation(automation.id, {
          name: name.trim(),
          window_metric: windowMetric,
          window_operator: windowOperator,
          window_threshold: thresholdNumber,
          evaluation_window: windowEval,
          action_config:
            automation.action_type === "webhook"
              ? { url: url.trim() }
              : automation.action_type === "slack"
                ? url.trim()
                  ? { url: url.trim() }
                  : undefined
                : { owner: owner.trim(), repo: repo.trim() },
          ...(githubToken.trim() ? { github_token: githubToken.trim() } : {}),
        });
        onUpdated(updated);
        onOpenChange(false);
        return;
      }
      const updated = await updateAutomation(automation.id, {
        name: name.trim(),
        event_type: useAdvanced ? advancedEvent : rule.event,
        conditions: useAdvanced
          ? advancedConditions.map((condition) => ({
              field: condition.field,
              operator: condition.operator,
              value: parseConditionValue(condition.value),
            }))
          : rule.conditions,
        action_config:
          automation.action_type === "webhook"
            ? { url: url.trim() }
            : automation.action_type === "slack"
              ? url.trim()
                ? { url: url.trim() }
                : undefined
              : { owner: owner.trim(), repo: repo.trim() },
        ...(githubToken.trim() ? { github_token: githubToken.trim() } : {}),
      });
      onUpdated(updated);
      onOpenChange(false);
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : "Failed to update automation");
    } finally {
      setSubmitting(false);
    }
  }, [
    advancedConditions,
    advancedEvent,
    automation.action_type,
    automation.id,
    githubToken,
    isWindow,
    name,
    onUpdated,
    onOpenChange,
    onError,
    owner,
    repo,
    rule,
    url,
    useAdvanced,
    windowEval,
    windowMetric,
    windowOperator,
    windowThreshold,
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Automation</DialogTitle>
          <DialogDescription>
            {automation.action_type === "github_issue"
              ? "GitHub issue · switching actions means recreating the rule"
              : automation.action_type === "slack"
                ? "Slack · switching actions means recreating the rule"
                : "Signed webhook · switching actions means recreating the rule"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="edit-automation-name">Name</Label>
            <Input
              id="edit-automation-name"
              className="h-8 text-xs"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {isWindow ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">Trigger</p>
            <p className="text-xs text-muted-foreground">
              Current value:{" "}
              <span className="font-mono tabular-nums">
                {formatWindowValue(
                  automation.window_metric,
                  automation.last_evaluated_value,
                )}
              </span>
              {automation.last_evaluated_at
                ? ` · last evaluated ${automation.last_evaluated_at.slice(0, 16).replace("T", " ")} UTC`
                : " · not evaluated yet"}
              {automation.enabled && automation.was_breached
                ? " · breaching now"
                : ""}
            </p>
            <div className="flex flex-wrap items-center gap-1.5 text-sm">
              <span>When</span>
              <select
                aria-label="Window metric"
                className={SELECT_CLASS + " w-40"}
                value={windowMetric}
                onChange={(e) => setWindowMetric(e.target.value as WindowMetricId)}
              >
                {Object.entries(WINDOW_METRIC_LABELS).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
              <span>is</span>
              <select
                aria-label="Window operator"
                className={SELECT_CLASS + " w-24"}
                value={windowOperator}
                onChange={(e) =>
                  setWindowOperator(e.target.value as WindowOperator)
                }
              >
                <option value="lt">below</option>
                <option value="gt">above</option>
                <option value="gte">at least</option>
              </select>
              <Input
                aria-label="Window threshold"
                className="h-8 w-20 font-mono text-xs tabular-nums"
                value={windowThreshold}
                onChange={(e) => setWindowThreshold(e.target.value)}
              />
              <span>over</span>
              <select
                aria-label="Evaluation window"
                className={SELECT_CLASS + " w-20"}
                value={windowEval}
                onChange={(e) => setWindowEval(e.target.value as EvaluationWindow)}
              >
                <option value="1h">1h</option>
                <option value="6h">6h</option>
                <option value="24h">24h</option>
                <option value="7d">7d</option>
              </select>
            </div>
            <p className="text-xs text-muted-foreground">
              Editing the trigger re-arms it: the next crossing of the
              threshold fires again.
            </p>
          </div>
          ) : null}

      {!isWindow ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium">When exactly?</p>
            <TriggerChoices
              trigger={trigger}
              taskFilter={taskFilter}
              useAdvanced={useAdvanced}
              onSelectTrigger={selectTrigger}
              onTaskFilterChange={setTaskFilter}
            />

            <button
              type="button"
              className="text-xs text-muted-foreground underline hover:text-foreground"
              onClick={() => {
                if (!advancedOpen) {
                  // Seed the raw editor from the current selection so opening
                  // Advanced never silently broadens or drops the rule.
                  patchDraft({
                    advancedEvent: advancedEvent || rule.event,
                    advancedConditions:
                      advancedConditions.length > 0
                        ? advancedConditions
                        : rule.conditions.map((condition) => ({
                            field: condition.field,
                            operator: condition.operator,
                            value: stringifyConditionValue(condition.value),
                          })),
                  });
                }
                patchDraft({ advancedOpen: !advancedOpen });
              }}
              aria-expanded={advancedOpen}
            >
              {advancedOpen ? "Hide" : "Advanced"} — raw event and conditions
            </button>
            {advancedOpen ? (
              <div className="flex flex-col gap-2">
                <AdvancedRuleEditor
                  event={advancedEvent}
                  conditions={advancedConditions}
                  onSelectEvent={selectAdvancedEvent}
                  onUpdateCondition={updateCondition}
                  onRemoveCondition={removeCondition}
                  onAddCondition={addCondition}
                />
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-2 text-xs">
            <p className="text-sm font-medium">Then</p>
            {automation.action_type === "webhook" ? (
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground">Webhook URL</span>
                <Input
                  aria-label="Webhook URL"
                  className="h-8 text-xs"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://…"
                />
              </label>
            ) : automation.action_type === "slack" ? (
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground">
                  Slack webhook URL — leave empty to keep{" "}
                  {String(automation.action_config.url_display ?? "the stored URL")}
                </span>
                <Input
                  aria-label="Slack webhook URL (optional replacement)"
                  className="h-8 text-xs"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://hooks.slack.com/services/… (only to replace)"
                />
              </label>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Owner</span>
                    <Input
                      aria-label="Repository owner"
                      className="h-8 text-xs"
                      value={owner}
                      onChange={(e) => setOwner(e.target.value)}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Repository</span>
                    <Input
                      aria-label="Repository name"
                      className="h-8 text-xs"
                      value={repo}
                      onChange={(e) => setRepo(e.target.value)}
                    />
                  </label>
                </div>
                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground">
                    GitHub token — leave empty to keep the stored token
                  </span>
                  <Input
                    type="password"
                    aria-label="GitHub token (optional replacement)"
                    className="h-8 text-xs"
                    value={githubToken}
                    onChange={(e) => setGithubToken(e.target.value)}
                    placeholder="ghp_… (only to replace)"
                  />
                </label>
              </>
            )}
          </div>
        </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-8"
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {submitting ? "Saving…" : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
