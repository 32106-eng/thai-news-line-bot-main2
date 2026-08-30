import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeFirestore } from "./helpers/fakeFirestore.js";
import { createGroupLinkService, GROUP_LINK_STATUS } from "../src/subscription/groupLinks.js";

function setup({ ownerIsPremium = true } = {}) {
  const { FieldValue, collection } = createFakeFirestore();
  const groupLinks = collection("groupLinks");
  const auditLog = async () => {};
  const subscriptionService = { isPremium: async () => ownerIsPremium };
  const service = createGroupLinkService({ groupLinks, FieldValue }, auditLog, subscriptionService);
  return { service, groupLinks, subscriptionService };
}

async function linkGroup(service, groupId = "group1", ownerId = "owner1") {
  await service.startPending(groupId);
  await service.confirmOwner(groupId, ownerId);
}

test("findNewlyExpiredLinked: returns LINKED groups whose owner is no longer Premium", async () => {
  const { service, subscriptionService } = setup({ ownerIsPremium: true });
  await linkGroup(service, "group1", "owner1");
  subscriptionService.isPremium = async () => false;
  const result = await service.findNewlyExpiredLinked();
  assert.deepEqual(result, [{ groupId: "group1", ownerId: "owner1" }]);
});

test("findNewlyExpiredLinked: skips groups whose owner is still Premium", async () => {
  const { service } = setup({ ownerIsPremium: true });
  await linkGroup(service, "group1", "owner1");
  const result = await service.findNewlyExpiredLinked();
  assert.deepEqual(result, []);
});

test("askReconfirm: moves LINKED group to RECONFIRM_PENDING", async () => {
  const { service } = setup({ ownerIsPremium: true });
  await linkGroup(service, "group1", "owner1");
  await service.askReconfirm("group1");
  const raw = await service.getRaw("group1");
  assert.equal(raw.status, GROUP_LINK_STATUS.RECONFIRM_PENDING);
});

test("isPremiumGroup: false while RECONFIRM_PENDING even if owner briefly re-shows premium (still gated until reconfirmOwner)", async () => {
  const { service, subscriptionService } = setup({ ownerIsPremium: true });
  await linkGroup(service, "group1", "owner1");
  subscriptionService.isPremium = async () => false;
  await service.askReconfirm("group1");
  assert.equal(await service.isPremiumGroup("group1"), false);
});

test("reconfirmOwner: NOT_PENDING when group was never asked to reconfirm", async () => {
  const { service } = setup({ ownerIsPremium: true });
  await linkGroup(service, "group1", "owner1");
  const result = await service.reconfirmOwner("group1", "owner1");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NOT_PENDING");
});

test("reconfirmOwner: NOT_PREMIUM when confirmer isn't Premium", async () => {
  const { service, subscriptionService } = setup({ ownerIsPremium: true });
  await linkGroup(service, "group1", "owner1");
  subscriptionService.isPremium = async () => false;
  await service.askReconfirm("group1");
  const result = await service.reconfirmOwner("group1", "someone");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NOT_PREMIUM");
});

test("reconfirmOwner: succeeds, re-links to LINKED with the new confirmer as owner, and no deadline is enforced", async () => {
  const { service, subscriptionService } = setup({ ownerIsPremium: true });
  await linkGroup(service, "group1", "owner1");
  subscriptionService.isPremium = async () => false; // owner1's premium lapses
  await service.askReconfirm("group1");
  subscriptionService.isPremium = async () => true; // someone else (or owner1 renewed) is premium now
  const result = await service.reconfirmOwner("group1", "owner2");
  assert.equal(result.ok, true);
  const raw = await service.getRaw("group1");
  assert.equal(raw.status, GROUP_LINK_STATUS.LINKED);
  assert.equal(raw.ownerId, "owner2");
  assert.equal(await service.isPremiumGroup("group1"), true);
});

test("declineReconfirm: NOT_PENDING when group was never asked to reconfirm", async () => {
  const { service } = setup({ ownerIsPremium: true });
  await linkGroup(service, "group1", "owner1");
  const result = await service.declineReconfirm("group1", "owner1");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NOT_PENDING");
});

test("declineReconfirm: succeeds and marks the group REJECTED (caller should leaveGroup)", async () => {
  const { service, subscriptionService } = setup({ ownerIsPremium: true });
  await linkGroup(service, "group1", "owner1");
  subscriptionService.isPremium = async () => false;
  await service.askReconfirm("group1");
  const result = await service.declineReconfirm("group1", "owner1");
  assert.equal(result.ok, true);
  const raw = await service.getRaw("group1");
  assert.equal(raw.status, GROUP_LINK_STATUS.REJECTED);
});
