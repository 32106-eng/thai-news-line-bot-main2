import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeFirestore } from "./helpers/fakeFirestore.js";
import { createSubscriptionService, SUB_STATUS } from "../src/subscription/subscriptions.js";

function setup() {
  const { db, FieldValue, collection } = createFakeFirestore();
  const subscriptions = collection("subscriptions");
  const auditLog = async () => {}; // no-op logger for tests
  const service = createSubscriptionService({ subscriptions, FieldValue, db }, auditLog);
  return { service, subscriptions };
}

test("isPremium: false for a user with no subscription doc at all", async () => {
  const { service } = setup();
  assert.equal(await service.isPremium("user1"), false);
});

test("isPremium: false when client-side would claim premium but DB says EXPIRED", async () => {
  const { service, subscriptions } = setup();
  await subscriptions.doc("user1").set({ status: SUB_STATUS.EXPIRED, expiresAt: new Date(Date.now() + 999_999_999) });
  // even though expiresAt is in the future, status isn't ACTIVE -> must be false
  assert.equal(await service.isPremium("user1"), false);
});

test("isPremium: false when status ACTIVE but expires_at already passed (never trust status alone)", async () => {
  const { service, subscriptions } = setup();
  await subscriptions.doc("user1").set({ status: SUB_STATUS.ACTIVE, expiresAt: new Date(Date.now() - 1000) });
  assert.equal(await service.isPremium("user1"), false);
});

test("isPremium: true when ACTIVE and not yet expired", async () => {
  const { service, subscriptions } = setup();
  await subscriptions.doc("user1").set({ status: SUB_STATUS.ACTIVE, expiresAt: new Date(Date.now() + 999_999_999) });
  assert.equal(await service.isPremium("user1"), true);
});

test("activateOrRenew: first activation sets expiry to ~1 month from now", async () => {
  const { service } = setup();
  const before = Date.now();
  const { newExpiry, wasRenewal } = await service.activateOrRenew({ userId: "user1", paymentTransactionId: "TX1" });
  assert.equal(wasRenewal, false);
  const daysUntilExpiry = (newExpiry.getTime() - before) / 86_400_000;
  assert.ok(daysUntilExpiry > 27 && daysUntilExpiry < 32, `expected ~1 month, got ${daysUntilExpiry} days`);
});

test("activateOrRenew: renewing while still active extends from current expiry, not from now", async () => {
  const { service, subscriptions } = setup();
  const currentExpiry = new Date(Date.now() + 10 * 86_400_000); // 10 days from now
  await subscriptions.doc("user1").set({ status: SUB_STATUS.ACTIVE, expiresAt: currentExpiry, startedAt: new Date() });
  const { newExpiry, wasRenewal } = await service.activateOrRenew({ userId: "user1", paymentTransactionId: "TX2" });
  assert.equal(wasRenewal, true);
  // new expiry should be ~1 month after the *old* expiry, i.e. user doesn't lose the remaining 10 days
  const expectedApprox = currentExpiry.getTime() + 30 * 86_400_000;
  assert.ok(Math.abs(newExpiry.getTime() - expectedApprox) < 3 * 86_400_000);
});

test("activateOrRenew: renewing after expiry starts fresh from now (doesn't stack onto stale expiry)", async () => {
  const { service, subscriptions } = setup();
  const staleExpiry = new Date(Date.now() - 40 * 86_400_000); // expired over a month ago
  await subscriptions.doc("user1").set({ status: SUB_STATUS.EXPIRED, expiresAt: staleExpiry, startedAt: staleExpiry });
  const { newExpiry } = await service.activateOrRenew({ userId: "user1", paymentTransactionId: "TX3" });
  const daysFromNow = (newExpiry.getTime() - Date.now()) / 86_400_000;
  assert.ok(daysFromNow > 27 && daysFromNow < 32);
});

test("activateOrRenew: still-active renewal keeps the original startedAt (it's the same subscription continuing)", async () => {
  const { service, subscriptions } = setup();
  const originalStart = new Date(Date.now() - 20 * 86_400_000); // started 20 days ago
  const currentExpiry = new Date(Date.now() + 10 * 86_400_000);
  await subscriptions.doc("user1").set({ status: SUB_STATUS.ACTIVE, expiresAt: currentExpiry, startedAt: originalStart });
  await service.activateOrRenew({ userId: "user1", paymentTransactionId: "TX4" });
  const raw = await service.getRaw("user1");
  assert.equal(raw.startedAt.getTime(), originalStart.getTime());
});

test("activateOrRenew: re-subscribing after an admin cancellation resets startedAt to now, not the old signup date", async () => {
  const { service, subscriptions } = setup();
  const originalStart = new Date(Date.now() - 60 * 86_400_000); // originally started 60 days ago (e.g. signed up on the 9th)
  const stillFutureExpiry = new Date(Date.now() + 15 * 86_400_000); // admin cancel doesn't touch expiresAt, only status
  await subscriptions.doc("user1").set({ status: SUB_STATUS.ACTIVE, expiresAt: stillFutureExpiry, startedAt: originalStart });
  const cancelResult = await service.adminCancel({ userId: "user1", adminUsername: "admin1" });
  assert.equal(cancelResult.ok, true);

  const before = Date.now();
  const { wasRenewal } = await service.activateOrRenew({ userId: "user1", paymentTransactionId: "TX5" }); // user re-subscribes fresh (e.g. on the 11th)
  assert.equal(wasRenewal, false); // this is a brand new signup, not a renewal — status was EXPIRED going in
  const raw = await service.getRaw("user1");
  assert.notEqual(raw.startedAt.getTime(), originalStart.getTime()); // must NOT still show the old (e.g. 9th) date
  assert.ok(Math.abs(raw.startedAt.getTime() - before) < 5000); // should be ~now instead
});

test("markExpiredIfNeeded: flips ACTIVE-but-past-expiry to EXPIRED", async () => {
  const { service, subscriptions } = setup();
  await subscriptions.doc("user1").set({ status: SUB_STATUS.ACTIVE, expiresAt: new Date(Date.now() - 1000) });
  const changed = await service.markExpiredIfNeeded("user1");
  assert.equal(changed, true);
  const raw = await service.getRaw("user1");
  assert.equal(raw.status, SUB_STATUS.EXPIRED);
});

test("adminCancel: flips an ACTIVE user to EXPIRED so isPremium() becomes false immediately", async () => {
  const { service, subscriptions } = setup();
  await subscriptions.doc("user1").set({ status: SUB_STATUS.ACTIVE, expiresAt: new Date(Date.now() + 999_999_999) });
  const result = await service.adminCancel({ userId: "user1", adminUsername: "admin1" });
  assert.equal(result.ok, true);
  assert.equal(await service.isPremium("user1"), false);
  const raw = await service.getRaw("user1");
  assert.equal(raw.status, SUB_STATUS.EXPIRED);
});

test("adminCancel: no-op error when user has no subscription doc", async () => {
  const { service } = setup();
  const result = await service.adminCancel({ userId: "ghost", adminUsername: "admin1" });
  assert.equal(result.ok, false);
});

test("adminCancel: no-op error when user is already not ACTIVE", async () => {
  const { service, subscriptions } = setup();
  await subscriptions.doc("user1").set({ status: SUB_STATUS.EXPIRED, expiresAt: new Date(Date.now() - 1000) });
  const result = await service.adminCancel({ userId: "user1", adminUsername: "admin1" });
  assert.equal(result.ok, false);
});
