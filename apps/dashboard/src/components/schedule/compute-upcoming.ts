export interface ScheduleConfig {
  cadence_type: "daily" | "weekly" | "monthly" | "adaptive";
  timezone: string;
  hour: number;
  minute: number;
  day_of_week?: number | null;
  day_of_month?: number | null;
  min_interval_days?: number;
  max_interval_days?: number;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ordinal(n: number): string {
  if (n > 3 && n < 21) return `${n}th`;
  const s: Record<number, string> = { 1: "st", 2: "nd", 3: "rd" };
  return `${n}${s[n % 10] ?? "th"}`;
}

export function describeSchedule(config: ScheduleConfig): string {
  const h = config.hour % 12 || 12;
  const m = String(config.minute).padStart(2, "0");
  const ampm = config.hour >= 12 ? "PM" : "AM";
  const time = `${h}:${m} ${ampm}`;

  if (config.cadence_type === "adaptive") {
    const max = config.max_interval_days ?? 30;
    return `Smart scheduling, up to every ${max} day${max === 1 ? "" : "s"} at ${time}`;
  }
  if (config.cadence_type === "daily") return `Every day at ${time}`;
  if (config.cadence_type === "weekly") {
    return `Every ${DAY_NAMES[config.day_of_week ?? 1]} at ${time}`;
  }
  if (config.cadence_type === "monthly") {
    return `${ordinal(config.day_of_month ?? 1)} of every month at ${time}`;
  }
  return "";
}
