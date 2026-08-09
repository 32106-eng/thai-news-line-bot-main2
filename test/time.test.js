import { test } from "node:test";
import assert from "node:assert/strict";
import { addMonths, addMinutes, isExpired, daysRemaining } from "../src/shared/time.js";

test("addMonths: renewal before expiry extends from current expiry (spec §14)", () => {
  const currentExpiry = new Date("2026-08-20T13:00:00Z");
  const result = addMonths(currentExpiry, 1);
  assert.equal(result.getUTCFullYear(), 2026);
  assert.equal(result.getUTCMonth(), 8); // September (0-indexed)
  assert.equal(result.getUTCDate(), 20);
});

test("addMonths: handles month-end overflow (31 Jan + 1 month -> Feb 28/29)", () => {
  const jan31 = new Date("2026-01-31T00:00:00Z");
  const result = addMonths(jan31, 1);
  assert.equal(result.getUTCMonth(), 1); // February
  assert.ok(result.getUTCDate() === 28 || result.getUTCDate() === 29);
});

test("addMonths: renewal after expiry starts fresh from now, not from old expiry", () => {
  const now = new Date("2026-08-08T10:00:00Z");
  const result = addMonths(now, 1);
  assert.equal(result.getUTCFullYear(), 2026);
  assert.equal(result.getUTCMonth(), 8);
  assert.equal(result.getUTCDate(), 8);
});

test("addMinutes: payment session TTL math", () => {
  const base = new Date("2026-08-08T10:00:00Z");
  const result = addMinutes(base, 20);
  assert.equal(result.getTime() - base.getTime(), 20 * 60_000);
});

test("isExpired: null/undefined counts as expired", () => {
  assert.equal(isExpired(null), true);
  assert.equal(isExpired(undefined), true);
});

test("isExpired: future date is not expired, past date is", () => {
  assert.equal(isExpired(new Date(Date.now() + 60_000)), false);
  assert.equal(isExpired(new Date(Date.now() - 60_000)), true);
});

test("daysRemaining: never negative", () => {
  assert.equal(daysRemaining(new Date(Date.now() - 999_999_999)), 0);
});

test("daysRemaining: rounds up partial days", () => {
  const almostOneDay = new Date(Date.now() + 23 * 3_600_000);
  assert.equal(daysRemaining(almostOneDay), 1);
});
