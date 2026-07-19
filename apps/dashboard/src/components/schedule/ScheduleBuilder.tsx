"use client";

import { useMemo, useState } from "react";
import { Clock, Calendar, Sparkles, HelpCircle } from "lucide-react";
import { describeSchedule, type ScheduleConfig } from "./compute-upcoming";
import { MiniCalendar } from "./MiniCalendar";
import { getUpcomingDayInMonth } from "./MiniCalendar.utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSupportedTimezones, useClientDate } from "@/hooks/use-client-now";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export type CadenceType = "daily" | "weekly" | "monthly" | "adaptive";

export interface ScheduleBuilderValue {
  cadence_type: CadenceType;
  timezone: string;
  hour: number;
  minute: number;
  day_of_week: number | null;
  day_of_month: number | null;
  min_interval_days: number;
  max_interval_days: number;
}

interface ScheduleBuilderProps {
  value: ScheduleBuilderValue;
  onChange: (value: ScheduleBuilderValue) => void;
}

const CADENCE_OPTIONS: { type: CadenceType; label: string }[] = [
  { type: "daily", label: "Daily" },
  { type: "weekly", label: "Weekly" },
  { type: "monthly", label: "Monthly" },
  { type: "adaptive", label: "Smart" },
];

export function ScheduleBuilder({ value, onChange }: ScheduleBuilderProps) {
  const timezones = useSupportedTimezones();
  const [tzSearch, setTzSearch] = useState("");
  const [showTzList, setShowTzList] = useState(false);

  const clientDate = useClientDate();
  const [calYear, setCalYear] = useState(2025);
  const [calMonth, setCalMonth] = useState(0);
  // Sync calendar to today's date once the client date resolves (SSR-safe).
  const [prevClientDay, setPrevClientDay] = useState<number | null>(null);
  if (clientDate && clientDate.day !== prevClientDay) {
    setPrevClientDay(clientDate.day);
    setCalYear(clientDate.year);
    setCalMonth(clientDate.month);
  }

  const config: ScheduleConfig = value;
  const description = describeSchedule(config);

  const calendarHighlights = useMemo(() => {
    if (value.cadence_type === "monthly" && value.day_of_month) {
      return getUpcomingDayInMonth(value.day_of_month, 3).reduce<number[]>((acc, d) => {
        if (d.year === calYear && d.month === calMonth) acc.push(d.day);
        return acc;
      }, []);
    }
    return [];
  }, [value.cadence_type, value.day_of_month, calYear, calMonth]);

  const filteredTz = useMemo(() => {
    if (!tzSearch) return timezones.slice(0, 20);
    return timezones.filter((tz) => tz.toLowerCase().includes(tzSearch.toLowerCase())).slice(0, 20);
  }, [timezones, tzSearch]);

  const handleCadenceChange = (type: CadenceType) => {
    if (type === "daily") {
      onChange({ ...value, cadence_type: "daily", day_of_week: null, day_of_month: null });
    } else if (type === "weekly") {
      onChange({ ...value, cadence_type: "weekly", day_of_week: value.day_of_week ?? 1, day_of_month: null });
    } else if (type === "monthly") {
      onChange({ ...value, cadence_type: "monthly", day_of_week: null, day_of_month: value.day_of_month ?? 1 });
    } else {
      onChange({ ...value, cadence_type: "adaptive", day_of_week: null, day_of_month: null });
    }
  };

  const handleDayClick = (day: number) => {
    onChange({ ...value, day_of_month: day });
  };

  const handleWeekdayClick = (dow: number) => {
    onChange({ ...value, day_of_week: dow });
  };

  return (
    <div className="space-y-5">
      {/* Frequency type — segmented control */}
      <div>
        <span className="block text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">
          Repeat pattern
        </span>
        <div className="flex gap-1 rounded-lg border border-border/60 bg-muted/30 p-1">
          {CADENCE_OPTIONS.map((opt) => (
            <button
              key={opt.type}
              type="button"
              onClick={() => handleCadenceChange(opt.type)}
              className={`flex-1 px-3 py-2 rounded-md text-xs font-medium transition-all inline-flex items-center justify-center gap-1 ${
                value.cadence_type === opt.type
                  ? "bg-foreground/10 text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-foreground/5"
              }`}
            >
              {opt.type === "adaptive" && <Sparkles size={11} />}
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Contextual details — only for the selected cadence */}
      {value.cadence_type === "weekly" && (
        <div>
          <span className="block text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">
            Day of week
          </span>
          <div className="flex gap-1.5">
            {WEEKDAYS.map((label, i) => (
              <button
                key={label}
                type="button"
                onClick={() => handleWeekdayClick(i)}
                className={`flex-1 py-2 rounded-md text-xs font-medium border transition-colors ${
                  value.day_of_week === i
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border/60 text-muted-foreground hover:text-foreground hover:border-border"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {value.cadence_type === "monthly" && (
        <div className="rounded-lg border border-border/60 p-3">
          <MiniCalendar
            year={calYear}
            month={calMonth}
            selectedDay={value.day_of_month ?? null}
            highlightDays={calendarHighlights}
            mode="monthly"
            onDayClick={handleDayClick}
            onMonthChange={(y, m) => { setCalYear(y); setCalMonth(m); }}
          />
        </div>
      )}

      {value.cadence_type === "adaptive" && (
        <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2">
              <Sparkles size={14} className="text-muted-foreground shrink-0 mt-0.5" />
              <p className="text-xs text-muted-foreground leading-relaxed">
                Tasks start running <span className="text-foreground font-medium">daily</span>.
                Each task that passes backs off exponentially (up to{" "}
                <span className="text-foreground font-medium">{value.max_interval_days} days</span>).
                A failure resets that task to daily.
              </p>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="text-muted-foreground/60 hover:text-foreground transition-colors shrink-0"
                  aria-label="How smart scheduling works"
                >
                  <HelpCircle size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs max-w-xs">
                <div className="space-y-1">
                  <div className="font-medium">Smart Scheduling</div>
                  <div className="text-background/80">
                    Uses spaced repetition (SM-2). Each task tracks its own
                    interval independently. Passing tasks back off exponentially
                    (1d &rarr; 2.5d &rarr; 6d &hellip;); a single failure
                    resets to daily so regressions are caught fast. The schedule
                    runs at the configured time whenever any task is due.
                  </div>
                </div>
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="adaptive-min" className="block text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1.5">
                Min interval (days)
              </label>
              <input
                id="adaptive-min"
                type="number"
                min={1}
                max={365}
                value={value.min_interval_days}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (!isNaN(v) && v >= 1) {
                    onChange({ ...value, min_interval_days: v });
                  }
                }}
                className="h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
              />
            </div>
            <div>
              <label htmlFor="adaptive-max" className="block text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1.5">
                Max interval (days)
              </label>
              <input
                id="adaptive-max"
                type="number"
                min={1}
                max={365}
                value={value.max_interval_days}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (!isNaN(v) && v >= 1) {
                    onChange({ ...value, max_interval_days: v });
                  }
                }}
                className="h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
              />
            </div>
          </div>
          {value.min_interval_days > value.max_interval_days && (
            <p className="text-xs text-destructive">
              Min interval must be less than or equal to max interval.
            </p>
          )}
        </div>
      )}

      {/* Time + Timezone on one row — shared by all cadence types */}
      <div>
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">
          <Clock size={12} />
          Time &amp; Timezone
        </span>
        <div className="flex items-center gap-3">
          <input
            type="time"
            aria-label="Time"
            value={`${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`}
            onChange={(e) => {
              const [h, m] = e.target.value.split(":").map(Number);
              if (!isNaN(h) && !isNaN(m)) onChange({ ...value, hour: h, minute: m });
            }}
            className="h-10 w-28 shrink-0 rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
          />
          <div className="relative flex-1">
            <input
              type="text"
              aria-label="Timezone"
              value={showTzList ? tzSearch : value.timezone}
              onChange={(e) => {
                setTzSearch(e.target.value);
                if (!showTzList) setShowTzList(true);
              }}
              onFocus={() => { setShowTzList(true); setTzSearch(""); }}
              onBlur={() => { setTimeout(() => setShowTzList(false), 200); }}
              placeholder="Search timezone..."
              className="h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            />
            {showTzList && (
              <div className="absolute z-50 top-full mt-1 w-full max-h-48 overflow-y-auto rounded-lg border border-border bg-popover shadow-lg">
                {filteredTz.map((tz) => (
                  <button
                    key={tz}
                    type="button"
                    onMouseDown={() => {
                      onChange({ ...value, timezone: tz });
                      setShowTzList(false);
                      setTzSearch("");
                    }}
                    className={`w-full text-left px-3 py-2 text-sm font-mono hover:bg-accent transition-colors ${
                      tz === value.timezone ? "bg-accent/50 text-accent-foreground" : "text-foreground"
                    }`}
                  >
                    {tz}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Summary */}
      <div className="rounded-lg border border-border/60 bg-muted/20 p-4">
        <div className="flex items-center gap-1.5 mb-1">
          <Calendar size={12} className="text-muted-foreground" />
          <span className="text-sm font-medium">{description}</span>
        </div>
        <p className="text-xs text-muted-foreground font-mono">{value.timezone}</p>
      </div>
    </div>
  );
}