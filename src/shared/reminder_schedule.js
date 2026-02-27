export const REMINDER_HOUR_LOCAL = 12;
export const MAX_POSTPONED_WEEKDAYS = 5;
export const MAX_REMINDER_ATTEMPTS = 1 + MAX_POSTPONED_WEEKDAYS;

export function getCycleKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function getFirstMondayAtHour(year, monthIndex, hour = REMINDER_HOUR_LOCAL) {
  const firstDay = new Date(year, monthIndex, 1, hour, 0, 0, 0);
  const dayOfWeek = firstDay.getDay();
  const offset = (8 - dayOfWeek) % 7;
  return new Date(year, monthIndex, 1 + offset, hour, 0, 0, 0);
}

export function getCurrentOrNextCycleBase(now = new Date(), hour = REMINDER_HOUR_LOCAL) {
  const current = getFirstMondayAtHour(now.getFullYear(), now.getMonth(), hour);
  if (now.getTime() <= current.getTime()) return current;
  const nextMonth = now.getMonth() === 11 ? 0 : now.getMonth() + 1;
  const nextYear = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
  return getFirstMondayAtHour(nextYear, nextMonth, hour);
}

export function isWeekday(date) {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

export function nextWeekdaySameTime(date) {
  const next = new Date(date.getTime());
  do {
    next.setDate(next.getDate() + 1);
  } while (!isWeekday(next));
  return next;
}

export function buildCycleDueDates(baseDueAt, maxPostponedWeekdays = MAX_POSTPONED_WEEKDAYS) {
  const dueDates = [new Date(baseDueAt.getTime())];
  for (let i = 0; i < maxPostponedWeekdays; i += 1) {
    dueDates.push(nextWeekdaySameTime(dueDates[dueDates.length - 1]));
  }
  return dueDates;
}

export function resolveNextDueFromBase(baseDueAt, now = new Date(), maxPostponedWeekdays = MAX_POSTPONED_WEEKDAYS) {
  const dueDates = buildCycleDueDates(baseDueAt, maxPostponedWeekdays);
  const nowMs = now.getTime();
  for (let i = 0; i < dueDates.length; i += 1) {
    const dueAt = dueDates[i];
    if (dueAt.getTime() >= nowMs) {
      return {
        attemptNumber: i + 1,
        dueAt
      };
    }
  }
  return null;
}
