export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

export function getUpcomingDayInMonth(
  dayOfMonth: number,
  count: number = 3,
): { year: number; month: number; day: number }[] {
  const results: { year: number; month: number; day: number }[] = [];
  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth();

  for (let i = 0; i < count + 1; i++) {
    const daysInMonth = getDaysInMonth(y, m);
    const safeDay = Math.min(dayOfMonth, daysInMonth);

    if (i === 0) {
      if (safeDay > now.getDate()) {
        results.push({ year: y, month: m, day: safeDay });
      }
    } else {
      results.push({ year: y, month: m, day: safeDay });
    }

    m++;
    if (m > 11) {
      m = 0;
      y++;
    }
  }

  return results.slice(0, count);
}
