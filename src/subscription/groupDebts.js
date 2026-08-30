// จัดการ "หนี้ระหว่างสมาชิกในกลุ่ม" (spec: กลุ่มจดบัญชี)
// ตัวอย่างการใช้งาน: "/บอท @ชื่อ ติดหนี้ 100 ค่าข้าว 5/9" ในกลุ่ม
//   -> บันทึกว่า "authorId (คนพิมพ์) ให้ @ชื่อ (คนถูกแท็ก) ติดหนี้ 100 บาท ค่าข้าว ครบกำหนด 5 ก.ย."
// กติกาเคลียร์หนี้ (ตามที่ผู้ใช้ระบุ): เฉพาะคนที่เป็นคนกำหนดหนี้ (creditorId) เท่านั้นที่เคลียร์รายการนั้นได้
// dueDate เป็น optional เสมอ — ถ้าไม่ใส่ ก็ไม่มีการเตือน (ดู findDueReminders)
// เก็บแยกเป็น collection ของตัวเอง (ไม่ผูกกับ panuan_users) เพราะหนี้เป็นข้อมูลระดับกลุ่ม ไม่ใช่ของคนคนเดียว

import { toDate } from "./db.js";
import { now } from "../shared/time.js";
import { AUDIT_EVENTS } from "./auditLog.js";

export const DEBT_STATUS = Object.freeze({ OPEN: "OPEN", CLEARED: "CLEARED" });

export function createGroupDebtService({ groupDebts, FieldValue }, auditLog) {
  /** เพิ่มหนี้ใหม่ 1 รายการในกลุ่ม */
  async function addDebt({ groupId, creditorId, debtorId, amount, note, dueDate = null }) {
    const doc = {
      groupId: String(groupId),
      creditorId: String(creditorId),   // คนที่พิมพ์คำสั่ง (คนที่อีกฝ่ายติดหนี้อยู่)
      debtorId: String(debtorId),       // คนที่ถูกแท็ก (คนที่ติดหนี้)
      amount,
      note: note || "",
      dueDate: dueDate ?? null,         // Date หรือ null — ถ้า null แปลว่าไม่กำหนดวันคืน ไม่มีการเตือน
      status: DEBT_STATUS.OPEN,
      remindedAt: null,                 // กันเตือนซ้ำวันเดียวกันหลายรอบ (ดู findDueReminders)
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };
    const ref = await groupDebts.add(doc);
    await auditLog({ userId: creditorId, eventType: AUDIT_EVENTS.GROUP_DEBT_ADDED, metadata: { groupId, debtId: ref.id, debtorId, amount } });
    return { id: ref.id, ...doc };
  }

  /** รายการหนี้ทั้งหมดของกลุ่ม (ทั้ง OPEN และ CLEARED) เรียงใหม่สุดก่อน — ใช้แสดงในแดชบอร์ด */
  async function listByGroup(groupId) {
    const snap = await groupDebts.where("groupId", "==", String(groupId)).get();
    return snap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => (toDate(b.createdAt)?.getTime() ?? 0) - (toDate(a.createdAt)?.getTime() ?? 0));
  }

  /** หนี้ค้าง (OPEN) เฉพาะของกลุ่ม — สรุปยอดรวมต่อคู่คนใช้ในการ์ดตอบกลับได้ */
  async function listOpenByGroup(groupId) {
    const all = await listByGroup(groupId);
    return all.filter((debt) => debt.status === DEBT_STATUS.OPEN);
  }

  /**
   * เคลียร์หนี้ 1 รายการ (ตั้งเป็น CLEARED) — เฉพาะ creditorId เดิม (คนกำหนดหนี้) เท่านั้นที่เคลียร์ได้
   * ผลลัพธ์: { ok:true } | { ok:false, reason:"NOT_FOUND" | "NOT_CREDITOR" | "ALREADY_CLEARED" }
   */
  async function clearDebt({ debtId, groupId, requestedByUserId }) {
    const ref = groupDebts.doc(String(debtId));
    const snap = await ref.get();
    if (!snap.exists) return { ok: false, reason: "NOT_FOUND" };
    const debt = snap.data();
    if (String(debt.groupId) !== String(groupId)) return { ok: false, reason: "NOT_FOUND" };
    if (debt.status === DEBT_STATUS.CLEARED) return { ok: false, reason: "ALREADY_CLEARED" };
    if (String(debt.creditorId) !== String(requestedByUserId)) return { ok: false, reason: "NOT_CREDITOR" };
    await ref.set({ status: DEBT_STATUS.CLEARED, clearedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await auditLog({ userId: requestedByUserId, eventType: AUDIT_EVENTS.GROUP_DEBT_CLEARED, metadata: { groupId, debtId } });
    return { ok: true };
  }

  /**
   * หาหนี้ OPEN ที่ครบกำหนดวันนี้แล้ว (dueDate <= วันนี้ ตามเวลาไทย) และยังไม่เคยเตือนวันนี้ — ใช้โดย cron รายวัน
   * ทำเครื่องหมาย remindedAt กันเตือนซ้ำในรอบ cron เดียวกัน/วันเดียวกัน
   */
  async function findDueReminders() {
    const snap = await groupDebts.where("status", "==", DEBT_STATUS.OPEN).get();
    const due = [];
    const today = now();
    for (const doc of snap.docs) {
      const data = doc.data();
      const dueDate = toDate(data.dueDate);
      if (!dueDate) continue;
      if (dueDate.getTime() > today.getTime()) continue; // ยังไม่ถึงกำหนด
      const remindedAt = toDate(data.remindedAt);
      // เตือนซ้ำได้วันละครั้ง (ถ้ายังไม่เคลียร์) — เทียบวันที่ตามเวลาไทยแบบง่าย ๆ ด้วย toDateString ของ UTC+7
      const remindedToday = remindedAt && remindedAt.toDateString() === today.toDateString();
      if (remindedToday) continue;
      due.push({ id: doc.id, ...data });
    }
    return due;
  }

  async function markReminded(debtId) {
    await groupDebts.doc(String(debtId)).set({ remindedAt: FieldValue.serverTimestamp() }, { merge: true });
  }

  return { addDebt, listByGroup, listOpenByGroup, clearDebt, findDueReminders, markReminded };
}
