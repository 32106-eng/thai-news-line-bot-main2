import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeFirestore } from "./helpers/fakeFirestore.js";
import { createGroupDebtService, DEBT_STATUS } from "../src/subscription/groupDebts.js";

function setup() {
  const { FieldValue, collection } = createFakeFirestore();
  const groupDebts = collection("groupDebts");
  const auditLog = async () => {};
  const service = createGroupDebtService({ groupDebts, FieldValue }, auditLog);
  return { service, groupDebts };
}

test("addDebt: creates an OPEN debt record with the given fields", async () => {
  const { service } = setup();
  const debt = await service.addDebt({ groupId: "group1", creditorId: "alice", debtorId: "bob", amount: 100, note: "ค่าข้าว" });
  assert.equal(debt.groupId, "group1");
  assert.equal(debt.creditorId, "alice");
  assert.equal(debt.debtorId, "bob");
  assert.equal(debt.amount, 100);
  assert.equal(debt.note, "ค่าข้าว");
  assert.equal(debt.status, DEBT_STATUS.OPEN);
  assert.equal(debt.dueDate, null);
  assert.ok(debt.id);
});

test("addDebt: stores dueDate when provided", async () => {
  const { service } = setup();
  const dueDate = new Date(2026, 8, 5, 12); // 5 Sep 2026
  const debt = await service.addDebt({ groupId: "group1", creditorId: "alice", debtorId: "bob", amount: 50, note: "", dueDate });
  assert.equal(debt.dueDate.getTime(), dueDate.getTime());
});

test("listByGroup: returns only debts for that group, newest first", async () => {
  const { service } = setup();
  await service.addDebt({ groupId: "group1", creditorId: "alice", debtorId: "bob", amount: 10, note: "a" });
  await service.addDebt({ groupId: "group2", creditorId: "carl", debtorId: "dan", amount: 20, note: "b" });
  await service.addDebt({ groupId: "group1", creditorId: "alice", debtorId: "eve", amount: 30, note: "c" });
  const list = await service.listByGroup("group1");
  assert.equal(list.length, 2);
  assert.ok(list.every((d) => d.groupId === "group1"));
});

test("listOpenByGroup: excludes cleared debts", async () => {
  const { service } = setup();
  const debt1 = await service.addDebt({ groupId: "group1", creditorId: "alice", debtorId: "bob", amount: 10, note: "a" });
  await service.addDebt({ groupId: "group1", creditorId: "alice", debtorId: "bob", amount: 20, note: "b" });
  await service.clearDebt({ debtId: debt1.id, groupId: "group1", requestedByUserId: "alice" });
  const open = await service.listOpenByGroup("group1");
  assert.equal(open.length, 1);
  assert.equal(open[0].amount, 20);
});

test("clearDebt: succeeds when requested by the original creditor", async () => {
  const { service } = setup();
  const debt = await service.addDebt({ groupId: "group1", creditorId: "alice", debtorId: "bob", amount: 100, note: "" });
  const result = await service.clearDebt({ debtId: debt.id, groupId: "group1", requestedByUserId: "alice" });
  assert.equal(result.ok, true);
  const [reloaded] = await service.listByGroup("group1");
  assert.equal(reloaded.status, DEBT_STATUS.CLEARED);
});

test("clearDebt: NOT_CREDITOR when requested by someone other than the original creditor", async () => {
  const { service } = setup();
  const debt = await service.addDebt({ groupId: "group1", creditorId: "alice", debtorId: "bob", amount: 100, note: "" });
  const result = await service.clearDebt({ debtId: debt.id, groupId: "group1", requestedByUserId: "bob" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NOT_CREDITOR");
});

test("clearDebt: NOT_FOUND for an unknown debt id", async () => {
  const { service } = setup();
  const result = await service.clearDebt({ debtId: "nope", groupId: "group1", requestedByUserId: "alice" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NOT_FOUND");
});

test("clearDebt: NOT_FOUND when the debt belongs to a different group", async () => {
  const { service } = setup();
  const debt = await service.addDebt({ groupId: "group1", creditorId: "alice", debtorId: "bob", amount: 100, note: "" });
  const result = await service.clearDebt({ debtId: debt.id, groupId: "group2", requestedByUserId: "alice" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NOT_FOUND");
});

test("clearDebt: ALREADY_CLEARED when clearing twice", async () => {
  const { service } = setup();
  const debt = await service.addDebt({ groupId: "group1", creditorId: "alice", debtorId: "bob", amount: 100, note: "" });
  await service.clearDebt({ debtId: debt.id, groupId: "group1", requestedByUserId: "alice" });
  const result = await service.clearDebt({ debtId: debt.id, groupId: "group1", requestedByUserId: "alice" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ALREADY_CLEARED");
});

test("findDueReminders: includes an OPEN debt whose dueDate has passed", async () => {
  const { service } = setup();
  const yesterday = new Date(Date.now() - 86_400_000);
  await service.addDebt({ groupId: "group1", creditorId: "alice", debtorId: "bob", amount: 100, note: "", dueDate: yesterday });
  const due = await service.findDueReminders();
  assert.equal(due.length, 1);
});

test("findDueReminders: excludes debts with no dueDate set", async () => {
  const { service } = setup();
  await service.addDebt({ groupId: "group1", creditorId: "alice", debtorId: "bob", amount: 100, note: "" });
  const due = await service.findDueReminders();
  assert.equal(due.length, 0);
});

test("findDueReminders: excludes debts whose dueDate is still in the future", async () => {
  const { service } = setup();
  const tomorrow = new Date(Date.now() + 86_400_000);
  await service.addDebt({ groupId: "group1", creditorId: "alice", debtorId: "bob", amount: 100, note: "", dueDate: tomorrow });
  const due = await service.findDueReminders();
  assert.equal(due.length, 0);
});

test("findDueReminders: excludes cleared debts even if overdue", async () => {
  const { service } = setup();
  const yesterday = new Date(Date.now() - 86_400_000);
  const debt = await service.addDebt({ groupId: "group1", creditorId: "alice", debtorId: "bob", amount: 100, note: "", dueDate: yesterday });
  await service.clearDebt({ debtId: debt.id, groupId: "group1", requestedByUserId: "alice" });
  const due = await service.findDueReminders();
  assert.equal(due.length, 0);
});

test("findDueReminders / markReminded: does not repeat the same debt again the same day", async () => {
  const { service } = setup();
  const yesterday = new Date(Date.now() - 86_400_000);
  const debt = await service.addDebt({ groupId: "group1", creditorId: "alice", debtorId: "bob", amount: 100, note: "", dueDate: yesterday });
  const firstPass = await service.findDueReminders();
  assert.equal(firstPass.length, 1);
  await service.markReminded(debt.id);
  const secondPass = await service.findDueReminders();
  assert.equal(secondPass.length, 0);
});
