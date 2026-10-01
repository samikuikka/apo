"use client";

import { useCallback, useMemo, useState } from "react";
import {
  type EvaluationWindow,
  type WindowMetricId,
  type WindowOperator,
  WINDOW_METRIC_LABELS,
  formatWindowValue,
} from "@/lib/automations-api";
import {
  type AutomationSummary,
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
  type ConditionDraft,
  type TriggerId,
  EVENT_TYPES,
  fieldsForEvent,
  OPERATORS,
  parseConditionValue,
  ruleFromAutomation,
  SELECT_CLASS,
  stringifyConditionValue,
  TRIGGER_CHOICES,
  triggerToRule,
} from "./automation-presets";

interface EditAutomationDialogProps {
  automation: AutomationSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: (automation: AutomationSummary) => void;
  onError: (message: string | null) => void;
}

// Edit mirrors the create wizard's two questions with current values
// pre-filled. The action type is immutable (delete + recreate to switch);
// the GitHub token field starts empty and stays empty to keep the stored
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
  const [trigger, setTrigger] = useState<TriggerId>(
    source.mode === "preset" ? source.trigger : "scheduled",
  );
  const [taskFilter, setTaskFilter] = useState(
    source.mode === "preset" ? source.taskFilter : "",
  );
  const [advancedOpen, setAdvancedOpen] = useState(source.mode === "advanced");
  const [advancedEvent, setAdvancedEvent] = useState<
    AutomationSummary["event_type"] | ""
  >(source.mode === "advanced" ? source.event : "");
  const [advancedConditions, setAdvancedConditions] = useState<ConditionDraft[]>(
    source.mode === "advanced" ? source.conditions : [],
  );

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

  const rule = useMemo(
    () => triggerToRule(trigger, taskFilter),
    [trigger, taskFilter],
  );
  const useAdvanced = advancedOpen && advancedEvent !== "";

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

  const updateCondition = useCallback(
    (index: number, patch: Partial<ConditionDraft>) => {
      setAdvancedConditions((prev) =>
        prev.map((condition, i) =>
          i === index ? { ...condition, ...patch } : condition,
        ),
      );
    },
    [],
  );

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
            {TRIGGER_CHOICES.map((choice) => {
              const selected = trigger === choice.id && !useAdvanced;
              return (
                <button
                  key={choice.id}
                  type="button"
                  aria-pressed={selected}
                  className={`border p-3 text-left text-sm transition-colors ${
                    selected
                      ? "border-foreground bg-muted/30"
                      : "border-border bg-background hover:border-foreground/40"
                  }`}
                  onClick={() => {
                    setTrigger(choice.id);
                    setAdvancedOpen(false);
                  }}
                >
                  <span>
                    {choice.label}
                    <span className="block text-xs text-muted-foreground">
                      {choice.hint}
                    </span>
                  </span>
                  {selected ? (
                    <span aria-hidden className="float-right">
                      ●
                    </span>
                  ) : null}
                </button>
              );
            })}

            {trigger === "task" && !useAdvanced ? (
              <label className="mt-1 flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Task id</span>
                <Input
                  aria-label="Task id to watch"
                  className="h-8 text-xs"
                  value={taskFilter}
                  onChange={(e) => setTaskFilter(e.target.value)}
                  placeholder="data-extraction"
                />
              </label>
            ) : null}

            <button
              type="button"
              className="text-xs text-muted-foreground underline hover:text-foreground"
              onClick={() => {
                if (!advancedOpen) {
                  // Seed the raw editor from the current selection so opening
                  // Advanced never silently broadens or drops the rule.
                  setAdvancedEvent((prev) => prev || rule.event);
                  setAdvancedConditions((prev) =>
                    prev.length > 0
                      ? prev
                      : rule.conditions.map((condition) => ({
                          field: condition.field,
                          operator: condition.operator,
                          value: stringifyConditionValue(condition.value),
                        })),
                  );
                }
                setAdvancedOpen(!advancedOpen);
              }}
              aria-expanded={advancedOpen}
            >
              {advancedOpen ? "Hide" : "Advanced"} — raw event and conditions
            </button>
            {advancedOpen ? (
              <div className="flex flex-col gap-2">
                <select
                  aria-label="Raw event type"
                  className={SELECT_CLASS}
                  value={advancedEvent}
                  onChange={(e) => {
                    setAdvancedEvent(e.target.value as AutomationSummary["event_type"]);
                    setAdvancedConditions([]);
                  }}
                >
                  <option value="">Choose an event…</option>
                  {EVENT_TYPES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {advancedEvent ? (
                  <div className="flex flex-col gap-2">
                    {advancedConditions.map((condition, index) => (
                      <div
                        key={index}
                        className="flex flex-col gap-1 sm:flex-row sm:items-center"
                      >
                        <select
                          aria-label={`Condition ${index + 1} field`}
                          className={`${SELECT_CLASS} sm:flex-1`}
                          value={condition.field}
                          onChange={(e) =>
                            updateCondition(index, { field: e.target.value })
                          }
                        >
                          {fieldsForEvent(advancedEvent).map((field) => (
                            <option key={field} value={field}>
                              {field}
                            </option>
                          ))}
                        </select>
                        <select
                          aria-label={`Condition ${index + 1} operator`}
                          className={SELECT_CLASS}
                          value={condition.operator}
                          onChange={(e) =>
                            updateCondition(index, { operator: e.target.value })
                          }
                        >
                          {OPERATORS.map((operator) => (
                            <option key={operator} value={operator}>
                              {operator}
                            </option>
                          ))}
                        </select>
                        <Input
                          aria-label={`Condition ${index + 1} value`}
                          className="h-8 flex-1 text-xs"
                          value={condition.value}
                          onChange={(e) =>
                            updateCondition(index, { value: e.target.value })
                          }
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7"
                          onClick={() =>
                            setAdvancedConditions((prev) =>
                              prev.filter((_, i) => i !== index),
                            )
                          }
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 self-start"
                      onClick={() =>
                        setAdvancedConditions((prev) => [
                          ...prev,
                          {
                            field: fieldsForEvent(advancedEvent)[0],
                            operator: "eq",
                            value: "",
                          },
                        ])
                      }
                    >
                      Add Condition
                    </Button>
                  </div>
                ) : null}
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
