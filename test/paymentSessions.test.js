import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeFirestore } from "./helpers/fakeFirestore.js";
import { createPaymentSessionService, SESSION_STATUS } from "../src/subscription/paymentSessions.js";

function setup() {
  const { db, FieldValue, collection } = createFakeFirestore();
  const paymentSessions = collection("paymentSessions");
  const auditLog = async () => {};
  const service = createPaymentSessionService({ paymentSessions, FieldValue, db }, auditLog);
  return { service, paymentSessions };
}

test("createOrReuse: creates a new session for a first-time subscriber", async () => {
  const { service } = setup();
  const { session, reused } = await service.createOrReuse("user1");
  assert.equal(reused, false);
  assert.equal(session.amount, 50);
  assert.equal(session.currency, "THB");
  assert.equal(session.status, SESSION_STATUS.WAITING_PAYMENT);
  assert.ok(session.referenceId.startsWith("PN"));
});

test("createOrReuse: double-tapping 'สมัครพรีเมียม' reuses the same session, doesn't create duplicates", async () => {
  const { service, paymentSessions } = setup();
  const first = await service.createOrReuse("user1");
  const second = await service.createOrReuse("user1");
  assert.equal(second.reused, true);
  assert.equal(second.session.id, first.session.id);
  const all = await paymentSessions.get();
  assert.equal(all.docs.length, 1);
});

test("each user's reference_id is unique across sessions", async () => {
  const { service } = setup();
  const a = await service.createOrReuse("userA");
  const b = await service.createOrReuse("userB");
  assert.notEqual(a.session.referenceId, b.session.referenceId);
});

test("validateForUpload: rejects when a different user tries to use someone else's session", async () => {
  const { service } = setup();
  const { session } = await service.createOrReuse("userA");
  const result = await service.validateForUpload(session.id, "userB");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "USER_MISMATCH");
});

test("validateForUpload: rejects an expired session", async () => {
  const { service, paymentSessions } = setup();
  const { session } = await service.createOrReuse("userA");
  await paymentSessions.doc(session.id).set({ expiresAt: new Date(Date.now() - 1000) }, { merge: true });
  const result = await service.validateForUpload(session.id, "userA");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "EXPIRED");
});

test("validateForUpload: rejects an already-consumed session (prevents reusing old slip flow)", async () => {
  const { service } = setup();
  const { session } = await service.createOrReuse("userA");
  await service.consume(session.id);
  const result = await service.validateForUpload(session.id, "userA");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ALREADY_CONSUMED");
});

test("consume: only succeeds once, second call returns false (idempotency for concurrent double-submit)", async () => {
  const { service } = setup();
  const { session } = await service.createOrReuse("userA");
  const first = await service.consume(session.id);
  const second = await service.consume(session.id);
  assert.equal(first, true);
  assert.equal(second, false);
});
