"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ThumbsUp, ThumbsDown, Star } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import {
  getScoreConfigs,
  createTraceScore,
  createObservationScore,
} from "@/lib/scores-api";
import type { ScoreConfig, ScoreResponse } from "@/lib/scores-api";
import { getProjectId } from "@/lib/config";
import { cn } from "@/lib/utils";

interface ScoreInputPanelProps {
  targetType: "trace" | "observation";
  targetId: string;
  existingScores?: ScoreResponse[];
  onScoreCreated?: () => void;
}

export function ScoreInputPanel({
  targetType,
  targetId,
  existingScores,
  onScoreCreated,
}: ScoreInputPanelProps) {
  const [configs, setConfigs] = useState<ScoreConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [scores, setScores] = useState<ScoreResponse[]>(existingScores ?? []);
  // Reset scores when the prop changes (e.g. navigating between traces) without
  // the stale-first-render flash of a useEffect-based mirror.
  const [prevExistingScores, setPrevExistingScores] = useState(existingScores);
  if (existingScores !== prevExistingScores) {
    setPrevExistingScores(existingScores);
    setScores(existingScores ?? []);
  }

  const project = getProjectId();

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    getScoreConfigs(project).then((result) => {
      if (!cancelled) {
        setConfigs(result);
        setIsLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [project]);

  const existingByConfig = useMemo(() => {
    const map = new Map<number, ScoreResponse>();
    for (const s of scores) {
      if (s.config_id != null) {
        map.set(s.config_id, s);
      }
    }
    return map;
  }, [scores]);

  const handleSubmit = useCallback(
    async (config: ScoreConfig, value: number | string | boolean, comment?: string) => {
      try {
        const request = {
          name: config.name,
          value,
          data_type: config.data_type,
          source: "ANNOTATION",
          config_id: config.id,
          comment: comment || undefined,
        };
        const result =
          targetType === "trace"
            ? await createTraceScore(targetId, request)
            : await createObservationScore(targetId, request);
        setScores((prev) => {
          const filtered = prev.filter((s) => s.config_id !== config.id);
          return [...filtered, result];
        });
        toast.success(`Score "${config.name}" saved`);
        onScoreCreated?.();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to save score",
        );
      }
    },
    [targetType, targetId, onScoreCreated],
  );

  if (isLoading) {
    return (
      <div className="space-y-2 p-3">
        <p className="text-xs text-muted-foreground">Loading score configs...</p>
      </div>
    );
  }

  if (configs.length === 0) {
    return (
      <div className="space-y-2 p-3">
        <p className="text-xs text-muted-foreground">
          No score configs available. Create a score config first to enable scoring.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 p-3">
      {scores.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {scores.map((s) => (
            <ExistingScoreBadge key={s.config_id ?? s.name} score={s} />
          ))}
        </div>
      )}
      {configs.map((config) => (
        <ScoreConfigInput
          key={config.id}
          config={config}
          existingScore={existingByConfig.get(config.id)}
          onSubmit={handleSubmit}
        />
      ))}
    </div>
  );
}

function ExistingScoreBadge({ score }: { score: ScoreResponse }) {
  const displayValue =
    score.data_type === "BOOLEAN"
      ? score.value
        ? "Pass"
        : "Fail"
      : typeof score.value === "number"
        ? score.value.toFixed(2)
        : String(score.value ?? "");

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        score.data_type === "BOOLEAN"
          ? score.value
            ? "border-success/30 bg-success/10 text-success"
            : "border-destructive/30 bg-destructive/10 text-destructive"
          : typeof score.value === "number" && score.value >= 0.8
            ? "border-success/30 bg-success/10 text-success"
            : typeof score.value === "number" && score.value >= 0.5
              ? "border-warning/30 bg-warning/10 text-warning"
              : "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      <span className="truncate max-w-[120px]">{score.name}</span>
      <span className="font-mono">{displayValue}</span>
    </span>
  );
}

interface ScoreConfigInputProps {
  config: ScoreConfig;
  existingScore?: ScoreResponse;
  onSubmit: (
    config: ScoreConfig,
    value: number | string | boolean,
    comment?: string,
  ) => void;
}

function ScoreConfigInput({
  config,
  existingScore,
  onSubmit,
}: ScoreConfigInputProps) {
  if (config.data_type === "BOOLEAN") {
    return (
      <BooleanScoreInput
        config={config}
        existingScore={existingScore}
        onSubmit={onSubmit}
      />
    );
  }
  if (config.data_type === "CATEGORICAL") {
    return (
      <CategoricalScoreInput
        config={config}
        existingScore={existingScore}
        onSubmit={onSubmit}
      />
    );
  }
  return (
    <NumericScoreInput
      config={config}
      existingScore={existingScore}
      onSubmit={onSubmit}
    />
  );
}

function BooleanScoreInput({
  config,
  existingScore,
  onSubmit,
}: ScoreConfigInputProps) {
  const [selected, setSelected] = useState<boolean | null>(
    existingScore != null ? (existingScore.value as boolean) : null,
  );

  const handleClick = (value: boolean) => {
    const next = selected === value ? null : value;
    setSelected(next);
    if (next !== null) {
      onSubmit(config, next);
    }
  };

  return (
    <div className="space-y-1.5 rounded-md border border-border px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{config.name}</span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Score ${config.name} thumbs up`}
            className={cn(
              selected === true && "bg-success/10 text-success hover:bg-success/20 hover:text-success",
            )}
            onClick={() => handleClick(true)}
          >
            <ThumbsUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Score ${config.name} thumbs down`}
            className={cn(
              selected === false && "bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive",
            )}
            onClick={() => handleClick(false)}
          >
            <ThumbsDown className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {config.description && (
        <p className="text-xs text-muted-foreground">{config.description}</p>
      )}
    </div>
  );
}

function NumericScoreInput({
  config,
  existingScore,
  onSubmit,
}: ScoreConfigInputProps) {
  const min = config.min_value ?? 0;
  const max = config.max_value ?? 1;
  const step = max - min <= 1 ? 0.01 : 0.1;
  const [value, setValue] = useState(
    existingScore != null ? (existingScore.value as number) : (min + max) / 2,
  );
  const [comment, setComment] = useState(existingScore?.comment ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSliderChange = (vals: number[]) => {
    setValue(vals[0]);
  };

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      await onSubmit(config, value, comment || undefined);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-border px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{config.name}</span>
        <span className="font-mono text-sm tabular-nums text-foreground">
          {value.toFixed(2)}
        </span>
      </div>
      {config.description && (
        <p className="text-xs text-muted-foreground">{config.description}</p>
      )}
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground">{min}</span>
        <Slider
          min={min}
          max={max}
          step={step}
          value={[value]}
          onValueChange={handleSliderChange}
          className="flex-1"
        />
        <span className="text-xs text-muted-foreground">{max}</span>
      </div>
      <Textarea
        placeholder="Optional reasoning..."
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        className="min-h-12 text-xs"
      />
      <Button
        type="button"
        size="sm"
        className="w-full"
        disabled={isSubmitting}
        onClick={handleSubmit}
      >
        <Star className="mr-1 h-3 w-3" />
        {existingScore ? "Update score" : "Submit score"}
      </Button>
    </div>
  );
}

function CategoricalScoreInput({
  config,
  existingScore,
  onSubmit,
}: ScoreConfigInputProps) {
  const categories = useMemo(() => {
    if (!config.categories) return [];
    return Object.entries(config.categories).map(([label, val]) => ({
      label,
      value: typeof val === "number" ? val : 0,
    }));
  }, [config.categories]);

  const [selected, setSelected] = useState<string | null>(
    existingScore?.string_value ?? null,
  );
  const [comment, setComment] = useState(existingScore?.comment ?? "");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!selected) return;
    const catValue =
      categories.find((c) => c.label === selected)?.value ?? 0;
    setIsSubmitting(true);
    try {
      await onSubmit(config, catValue, comment || undefined);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-border px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{config.name}</span>
      </div>
      {config.description && (
        <p className="text-xs text-muted-foreground">{config.description}</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {categories.map((cat) => (
          <Button
            key={cat.label}
            type="button"
            variant={selected === cat.label ? "default" : "outline"}
            size="xs"
            onClick={() =>
              setSelected(selected === cat.label ? null : cat.label)
            }
          >
            {cat.label}
          </Button>
        ))}
      </div>
      <Textarea
        placeholder="Optional reasoning..."
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        className="min-h-12 text-xs"
      />
      <Button
        type="button"
        size="sm"
        className="w-full"
        disabled={isSubmitting || !selected}
        onClick={handleSubmit}
      >
        <Star className="mr-1 h-3 w-3" />
        {existingScore ? "Update score" : "Submit score"}
      </Button>
    </div>
  );
}
