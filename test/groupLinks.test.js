import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeFirestore } from "./helpers/fakeFirestore.js";
import { createGroupLinkService, GROUP_LINK_STATUS, CONFIRM_WINDOW_MINUTES } from "../src/subscription/groupLinks.js";

function setup({ ownerIsPremium = true } = {}) {
  const { db, FieldValue, collection } = createFakeFirestore();
  const groupLinks = collection("groupLinks");
  const auditLog = async () => {}; // no-op logger for tests
  const subscriptionService = { isPremium: async () => ownerIsPremium };
  const service = createGroupLinkService({ groupLinks, FieldValue }, auditLog, subscriptionService);
  return { service, groupLinks, subscriptionService };
}

test("startPending: creates a PENDING link with a deadline ~CONFIRM_WINDOW_MINUTES from now", async () => {
  const { service } = setup();
  const before = Date.now();
  const { pendingUntil } = await service.startPending("group1");
  const raw = await service.getRaw("group1");
  assert.equal(raw.status, GROUP_LINK_STATUS.PENDING);
  assert.equal(raw.ownerId, null);
  const minutesUntilDeadline = (pendingUntil.getTime() - before) / 60_000;
  assert.ok(minutesUntilDeadline > CONFIRM_WINDOW_MINUTES - 1 && minutesUntilDeadline <= CONFIRM_WINDOW_MINUTES + 1);
});

test("confirmOwner: NOT_PENDING when there is no link record at all", async () => {
  const { service } = setup();
  const result = await service.confirmOwner("group1", "user1");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NOT_PENDING");
});

test("confirmOwner: succeeds and links the group when confirmer is Premium", async () => {
  const { service } = setup({ ownerIsPremium: true });
  await service.startPending("group1");
  const result = await service.confirmOwner("group1", "user1");
  assert.equal(result.ok, true);
  const raw = await service.getRaw("group1");
  assert.equal(raw.status, GROUP_LINK_STATUS.LINKED);
  assert.equal(raw.ownerId, "user1");
});

test("confirmOwner: rejects when confirmer is not Premium (caller should leaveGroup)", async () => {
  const { service } = setup({ ownerIsPremium: false });
  await service.startPending("group1");
  const result = await service.confirmOwner("group1", "user1");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NOT_PREMIUM");
  const raw = await service.getRaw("group1");
  assert.equal(raw.status, GROUP_LINK_STATUS.REJECTED);
});

test("confirmOwner: EXPIRED when past pendingUntil deadline", async () => {
  const { service, groupLinks } = setup();
  await service.startPending("group1");
  // force the deadline into the past
  await groupLinks.doc("group1").set({ pendingUntil: new Date(Date.now() - 1000) }, { merge: true });
  const result = await service.confirmOwner("group1", "user1");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "EXPIRED");
});

test("confirmOwner: NOT_PENDING when group is already LINKED (can't re-confirm)", async () => {
  const { service } = setup({ ownerIsPremium: true });
  await service.startPending("group1");
  await service.confirmOwner("group1", "user1");
  const result = await service.confirmOwner("group1", "user2");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NOT_PENDING");
});

test("isPremiumGroup: false when no link exists", async () => {
  const { service } = setup();
  assert.equal(await service.isPremiumGroup("group1"), false);
});

test("isPremiumGroup: false when link is still PENDING (not yet confirmed)", async () => {
  const { service } = setup();
  await service.startPending("group1");
  assert.equal(await service.isPremiumGroup("group1"), false);
});

test("isPremiumGroup: true when LINKED and owner is currently Premium", async () => {
  const { service } = setup({ ownerIsPremium: true });
  await service.startPending("group1");
  await service.confirmOwner("group1", "user1");
  assert.equal(await service.isPremiumGroup("group1"), true);
});

test("isPremiumGroup: false when LINKED but owner's Premium has since expired (checked live, not cached)", async () => {
  const { service, subscriptionService } = setup({ ownerIsPremium: true });
  await service.startPending("group1");
  await service.confirmOwner("group1", "user1");
  subscriptionService.isPremium = async () => false; // owner's subscription expired later
  assert.equal(await service.isPremiumGroup("group1"), false);
});

test("findExpiredPending: returns only groupIds whose pendingUntil has passed", async () => {
  const { service, groupLinks } = setup();
  await service.startPending("group1"); // not expired
  await service.startPending("group2");
  await groupLinks.doc("group2").set({ pendingUntil: new Date(Date.now() - 1000) }, { merge: true }); // expired
  await service.startPending("group3");
  await service.confirmOwner("group3", "user1"); // LINKED, not PENDING -> should never be flagged

  const expired = await service.findExpiredPending();
  assert.deepEqual(expired, ["group2"]);
});

test("markLeft: sets status to REJECTED and clears pendingUntil", async () => {
  const { service } = setup();
  await service.startPending("group1");
  await service.markLeft("group1");
  const raw = await service.getRaw("group1");
  assert.equal(raw.status, GROUP_LINK_STATUS.REJECTED);
  assert.equal(raw.pendingUntil, null);
});

test("removeLink: deletes the record entirely (used on LINE 'leave' event)", async () => {
  const { service } = setup();
  await service.startPending("group1");
  await service.removeLink("group1");
  assert.equal(await service.getRaw("group1"), null);
});

test("openReceiptWait / consumeReceiptWait: consumes only for the requesting user within the time window", async () => {
  const { service } = setup();
  await service.openReceiptWait("group1", "user1");
  // wrong sender -> not consumed
  assert.equal(await service.consumeReceiptWait("group1", "user2"), false);
  // correct sender -> consumed
  assert.equal(await service.consumeReceiptWait("group1", "user1"), true);
  // already consumed -> can't consume twice
  assert.equal(await service.consumeReceiptWait("group1", "user1"), false);
});

test("consumeReceiptWait: false when nothing was ever requested", async () => {
  const { service } = setup();
  assert.equal(await service.consumeReceiptWait("group1", "user1"), false);
});

test("consumeReceiptWait: false once the wait window has expired", async () => {
  const { service, groupLinks } = setup();
  await service.openReceiptWait("group1", "user1");
  await groupLinks.doc("group1").set({ pendingReceiptUntil: new Date(Date.now() - 1000) }, { merge: true });
  assert.equal(await service.consumeReceiptWait("group1", "user1"), false);
});
