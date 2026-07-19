"use client";

import { useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getDaysInMonth } from "./MiniCalendar.utils";
import { useClientDate } from "@/hooks/use-client-now";

const WEEKDAY_HEADERS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const EMPTY_HIGHLIGHT_DAYS: number[] = [];

function getFirstDayOfWeek(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

interface MiniCalendarProps {
  year: number;
  month: number;
  selectedDay?: number | null;
  highlightDays?: number[];
  mode?: "daily" | "weekly" | "monthly" | "adaptive" | null;
  onDayClick?: (day: number) => void;
  onMonthChange?: (year: number, month: number) => void;
}

export function MiniCalendar({
  year,
  month,
  selectedDay,
  highlightDays = EMPTY_HIGHLIGHT_DAYS,
  mode,
  onDayClick,
  onMonthChange,
}: MiniCalendarProps) {
  const today = useClientDate();

  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfWeek(year, month);
  const highlightSet = useMemo(() => new Set(highlightDays), [highlightDays]);

  const monthLabel = `${MONTH_NAMES[month]} ${year}`;

  const prevMonth = () => {
    if (month === 0) onMonthChange?.(year - 1, 11);
    else onMonthChange?.(year, month - 1);
  };

  const nextMonth = () => {
    if (month === 11) onMonthChange?.(year + 1, 0);
    else onMonthChange?.(year, month + 1);
  };

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const isCurrentMonth = today ? year === today.year && month === today.month : false;

  return (
    <div className="select-none">
      <div className="flex items-center justify-between mb-2 px-1">
        <button type="button" aria-label="Previous month" onClick={prevMonth} className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
          <ChevronLeft size={16} />
        </button>
        <span className="text-sm font-medium">{monthLabel}</span>
        <button type="button" aria-label="Next month" onClick={nextMonth} className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-0">
        {WEEKDAY_HEADERS.map((d) => (
          <div key={d} className="text-center text-[10px] font-medium text-muted-foreground/60 py-1">
            {d}
          </div>
        ))}

        {cells.map((day, i) => {
          if (day === null) return <div key={`empty-${i}`} />;

          const isToday = isCurrentMonth && today !== null && day === today.day;
          const isSelected = day === selectedDay;
          const isHighlighted = highlightSet.has(day);
          const isPast = isCurrentMonth && today !== null && day < today.day;

          if (mode === "daily") {
            return (
              <button
                key={day}
                type="button"
                onClick={() => onDayClick?.(day)}
                className={`h-8 w-8 mx-auto rounded-full text-xs font-medium flex items-center justify-center transition-all ${
                  isPast
                    ? "text-muted-foreground/30"
                    : isSelected
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : isToday
                        ? "ring-1 ring-primary text-primary font-bold"
                        : "bg-primary/8 text-primary/80 hover:bg-primary/15"
                }`}
              >
                {day}
              </button>
            );
          }

          return (
            <button
              key={day}
              type="button"
              onClick={() => onDayClick?.(day)}
              className={`h-8 w-8 mx-auto rounded-full text-xs font-medium flex items-center justify-center transition-all ${
                isSelected
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : isToday
                    ? "bg-accent text-accent-foreground font-bold"
                    : isHighlighted
                      ? "bg-primary/15 text-primary ring-1 ring-primary/30"
                      : isPast
                        ? "text-muted-foreground/30"
                        : "text-foreground hover:bg-muted"
              }`}
            >
              {day}
            </button>
          );
        })}
      </div>

      {mode && (
        <div className="mt-2 text-center">
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            {mode === "daily" ? "Every day" : mode === "weekly" ? "Highlighted days" : `Day ${selectedDay ?? "?"} each month`}
          </span>
        </div>
      )}
    </div>
  );
}
