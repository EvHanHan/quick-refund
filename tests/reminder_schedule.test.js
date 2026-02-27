import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCycleDueDates,
  getCurrentOrNextCycleBase,
  getFirstMondayAtHour,
  nextWeekdaySameTime,
  resolveNextDueFromBase
} from "../src/shared/reminder_schedule.js";

test("getFirstMondayAtHour resolves months where first Monday is on the 1st", () => {
  const value = getFirstMondayAtHour(2025, 8, 12); // September 2025
  assert.equal(value.getFullYear(), 2025);
  assert.equal(value.getMonth(), 8);
  assert.equal(value.getDate(), 1);
  assert.equal(value.getDay(), 1);
  assert.equal(value.getHours(), 12);
});

test("getFirstMondayAtHour resolves months where first Monday is after the 1st", () => {
  const value = getFirstMondayAtHour(2026, 1, 12); // February 2026
  assert.equal(value.getDate(), 2);
  assert.equal(value.getDay(), 1);
  assert.equal(value.getHours(), 12);
});

test("nextWeekdaySameTime skips weekend", () => {
  const friday = new Date(2026, 1, 6, 12, 0, 0, 0); // Friday
  const next = nextWeekdaySameTime(friday);
  assert.equal(next.getDay(), 1);
  assert.equal(next.getDate(), 9);
  assert.equal(next.getHours(), 12);
});

test("resolveNextDueFromBase returns first weekday retry after missed base due", () => {
  const baseDueAt = new Date(2026, 1, 2, 12, 0, 0, 0); // Monday
  const now = new Date(2026, 1, 2, 12, 1, 0, 0); // Monday after due
  const next = resolveNextDueFromBase(baseDueAt, now, 5);
  assert.ok(next);
  assert.equal(next.attemptNumber, 2);
  assert.equal(next.dueAt.getDay(), 2); // Tuesday
  assert.equal(next.dueAt.getDate(), 3);
});

test("resolveNextDueFromBase returns null after all retries are exhausted", () => {
  const baseDueAt = new Date(2026, 1, 2, 12, 0, 0, 0);
  const now = new Date(2026, 1, 12, 12, 1, 0, 0);
  const next = resolveNextDueFromBase(baseDueAt, now, 5);
  assert.equal(next, null);
});

test("buildCycleDueDates creates initial due plus 5 weekday retries", () => {
  const baseDueAt = new Date(2026, 1, 2, 12, 0, 0, 0);
  const dueDates = buildCycleDueDates(baseDueAt, 5);
  assert.equal(dueDates.length, 6);
  assert.equal(dueDates[0].getDate(), 2);
  assert.equal(dueDates[1].getDate(), 3);
  assert.equal(dueDates[5].getDate(), 9); // weekend skipped
});

test("getCurrentOrNextCycleBase returns next month when current cycle already passed", () => {
  const now = new Date(2026, 1, 10, 12, 0, 0, 0); // Feb 10, 2026
  const nextBase = getCurrentOrNextCycleBase(now, 12);
  assert.equal(nextBase.getFullYear(), 2026);
  assert.equal(nextBase.getMonth(), 2); // March
  assert.equal(nextBase.getDay(), 1);
});
