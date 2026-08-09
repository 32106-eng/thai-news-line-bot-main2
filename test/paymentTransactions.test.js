import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeFirestore } from "./helpers/fakeFirestore.js";
import { createPaymentTransactionService, TX_STATUS } from "../src/subscription/paymentTransactions.js";
import { NullPaymentProvider } from "../src/subscription/paymentProvider.js";

function setup(provider = new NullPaymentProvider()) {
  const { db, FieldValue, collection } = createFakeFirestore();
  const paymentTransactions = collection("paymentTransactions");
  const auditLog = async () => {};
  const activateCalls = [];
  const subscriptionService = { activateOrRenew: async (args) => { activateCalls.push(args); } };
  const service = createPaymentTransactionService(
    { paymentTransactions, FieldValue, db },
    { auditLog, paymentProvider: provider, subscriptionService }
  );
  return { service, paymentTransactions, activateCalls };
}

const fakeSession = { id: "sess1", amount: 50 };

test("submitAndVerify: unreadable OCR (no amount) is rejected, never approved", async () => {
  const { service, activateCalls } = setup();
  const result = await service.submitAndVerify({ userId: "u1", paymentSession: fakeSession, ocrData: null });
  assert.equal(result.outcome, TX_STATUS.REJECTED);
  assert.equal(activateCalls.length, 0);
});

test("submitAndVerify: no payment provider configured -> PENDING_REVIEW, not auto-approved (core requirement)", async () => {
  const { service, activateCalls } = setup();
  const result = await service.submitAndVerify({
    userId: "u1",
    paymentSession: fakeSession,
    ocrData: { amount: 50, transactionReference: "REF123" }
  });
  assert.equal(result.outcome, TX_STATUS.PENDING_REVIEW);
  assert.equal(activateCalls.length, 0, "Premium must NOT be activated just because OCR read a matching amount");
});

test("submitAndVerify: slip with no transaction reference at all -> PENDING_REVIEW", async () => {
  const { service } = setup();
  const result = await service.submitAndVerify({
    userId: "u1",
    paymentSession: fakeSession,
    ocrData: { amount: 50, transactionReference: null }
  });
  assert.equal(result.outcome, TX_STATUS.PENDING_REVIEW);
});

test("submitAndVerify: amount mismatch between slip and session -> PENDING_REVIEW, never silently approved", async () => {
  const { service } = setup();
  const result = await service.submitAndVerify({
    userId: "u1",
    paymentSession: fakeSession,
    ocrData: { amount: 999, transactionReference: "REF999" }
  });
  assert.equal(result.outcome, TX_STATUS.PENDING_REVIEW);
});

test("submitAndVerify: replay attack - same transaction_reference submitted twice is DUPLICATE the second time", async () => {
  const { service } = setup();
  const ocrData = { amount: 50, transactionReference: "REF-SAME" };
  const first = await service.submitAndVerify({ userId: "u1", paymentSession: fakeSession, ocrData });
  const second = await service.submitAndVerify({ userId: "u2", paymentSession: { id: "sess2", amount: 50 }, ocrData });
  assert.equal(first.outcome, TX_STATUS.PENDING_REVIEW);
  assert.equal(second.outcome, TX_STATUS.DUPLICATE, "a second user must not be able to reuse someone else's slip reference");
});

test("submitAndVerify: reference normalization prevents trivial case/whitespace bypass of duplicate check", async () => {
  const { service } = setup();
  const first = await service.submitAndVerify({ userId: "u1", paymentSession: fakeSession, ocrData: { amount: 50, transactionReference: "ref-abc" } });
  const second = await service.submitAndVerify({ userId: "u1", paymentSession: fakeSession, ocrData: { amount: 50, transactionReference: " REF-ABC " } });
  assert.equal(first.outcome, TX_STATUS.PENDING_REVIEW);
  assert.equal(second.outcome, TX_STATUS.DUPLICATE);
});

test("adminApprove: only works on a PENDING_REVIEW transaction and activates subscription exactly once", async () => {
  const { service, activateCalls } = setup();
  const submitted = await service.submitAndVerify({ userId: "u1", paymentSession: fakeSession, ocrData: { amount: 50, transactionReference: "REF-A" } });
  const approve1 = await service.adminApprove({ transactionReference: submitted.transactionReference, adminUsername: "admin1" });
  const approve2 = await service.adminApprove({ transactionReference: submitted.transactionReference, adminUsername: "admin1" });
  assert.equal(approve1.ok, true);
  assert.equal(approve2.ok, false, "approving an already-approved transaction again must fail");
  assert.equal(activateCalls.length, 1, "subscription must only be activated once even if approve is called twice");
});

test("adminReject: rejecting a PENDING_REVIEW transaction never activates subscription", async () => {
  const { service, activateCalls } = setup();
  const submitted = await service.submitAndVerify({ userId: "u1", paymentSession: fakeSession, ocrData: { amount: 50, transactionReference: "REF-B" } });
  const result = await service.adminReject({ transactionReference: submitted.transactionReference, adminUsername: "admin1", reason: "fake slip" });
  assert.equal(result.ok, true);
  assert.equal(activateCalls.length, 0);
});

test("with a provider that verifies successfully, transaction goes straight to VERIFIED and activates once", async () => {
  const verifyingProvider = { verifyTransaction: async () => ({ verified: true, canVerify: true, amount: 50, providerRef: "P-1" }) };
  const { service, activateCalls } = setup(verifyingProvider);
  const result = await service.submitAndVerify({ userId: "u1", paymentSession: fakeSession, ocrData: { amount: 50, transactionReference: "REF-C" } });
  assert.equal(result.outcome, TX_STATUS.VERIFIED);
  assert.equal(activateCalls.length, 1);
});

test("with a provider that actively rejects (canVerify true, verified false), transaction is REJECTED not PENDING_REVIEW", async () => {
  const rejectingProvider = { verifyTransaction: async () => ({ verified: false, canVerify: true, reason: "AMOUNT_MISMATCH_PROVIDER" }) };
  const { service, activateCalls } = setup(rejectingProvider);
  const result = await service.submitAndVerify({ userId: "u1", paymentSession: fakeSession, ocrData: { amount: 50, transactionReference: "REF-D" } });
  assert.equal(result.outcome, TX_STATUS.REJECTED);
  assert.equal(activateCalls.length, 0);
});
