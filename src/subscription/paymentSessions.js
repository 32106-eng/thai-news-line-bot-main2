
import crypto from "node:crypto";
import { toDate } from "./db.js";
import { addMinutes, isExpired } from "../shared/time.js";
import { AUDIT_EVENTS } from "./auditLog.js";

export const SESSION_STATUS = Object.freeze({
  WAITING_PAYMENT: "WAITING_PAYMENT",
  CONSUMED: "CONSUMED",
  EXPIRED: "EXPIRED"
});

const SESSION_TTL_MINUTES = 20;
// แผนที่ขายได้ตอนนี้: MONTHLY (รายเดือน +1 เดือน) และ YEARLY (รายปี +12 เดือน)
// ราคา/ระยะเวลาผูกกับ "ชื่อแผน" ไว้ที่จุดเดียวนี้จุดเดียว ห้ามให้ client ส่ง amount มาเอง (ดู checkout ใน index.js)
export const PLAN_CATALOG = Object.freeze({
  MONTHLY: { amount: 50, months: 1 },
  YEARLY: { amount: 370, months: 12 }
});
const DEFAULT_PLAN = "MONTHLY";
const PREMIUM_PRICE_THB = PLAN_CATALOG.MONTHLY.amount; // เก็บไว้เพื่อความเข้ากันได้ย้อนหลังกับโค้ดเดิมที่อ้างชื่อนี้ (เช่น handleSubscribeCommand ฝั่ง LINE ที่ยังขายแค่รายเดือน)
// กันผู้ใช้กด "สมัครพรีเมียม" รัว ๆ สร้าง session ใหม่ทุกครั้ง — ถ้ามี session ที่ยังไม่หมดอายุอยู่แล้ว ให้ใช้ตัวเดิม
const REUSE_WINDOW = true;

export function createPaymentSessionService({ paymentSessions, FieldValue, db }, auditLog) {
  function referenceId() {
    // สุ่มไม่ซ้ำในทางปฏิบัติ: 16 ไบต์สุ่ม hex + prefix เพื่ออ่านง่ายใน admin dashboard
    return `PN${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
  }

  async function findActiveSession(userId, plan) {
    const snap = await paymentSessions
      .where("userId", "==", userId)
      .where("status", "==", SESSION_STATUS.WAITING_PAYMENT)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    const data = { id: doc.id, ...doc.data() };
    if (isExpired(toDate(data.expiresAt))) return null;
    // เช็คว่า plan ตรงกันเฉพาะตอนที่ผู้เรียกระบุ plan มาจริง ๆ (เช่น createOrReuse ตอนกดเลือกแผนใหม่)
    // ถ้าไม่ได้ส่ง plan มาเลย (undefined) แปลว่าผู้เรียกแค่ถามว่า "มี session ค้างไหม" ไม่ได้สนใจว่าเป็นแผนไหน
    // (เช่น handleSendSlipCommand ตอนพิมพ์ "ส่งสลิป" ใน LINE) — ต้องไม่ตัดสิทธิ์ session ที่ยังไม่หมดอายุทิ้งไปเฉย ๆ
    // บั๊กเดิม: เรียกแบบไม่ส่ง plan แล้วโดน "MONTHLY" !== undefined ตัดสิทธิ์ ทำให้เจอ "ยังไม่มีรายการรอชำระเงิน" ทั้งที่เพิ่งสร้าง QR ไปหมาด ๆ
    if (plan !== undefined && data.plan && data.plan !== plan) return null;
    return data;
  }

  /** สร้าง payment session ใหม่ (หรือคืน session เดิมที่ยังไม่หมดอายุและแผนเดียวกัน เพื่อกัน double-submit สร้างซ้ำ) */
  async function createOrReuse(userId, planKey = DEFAULT_PLAN) {
    const plan = PLAN_CATALOG[planKey] ? planKey : DEFAULT_PLAN;
    const existing = REUSE_WINDOW ? await findActiveSession(userId, plan) : null;
    if (existing) return { session: existing, reused: true };

    const expiresAt = addMinutes(new Date(), SESSION_TTL_MINUTES);
    const docRef = paymentSessions.doc();
    const payload = {
      userId,
      referenceId: referenceId(),
      plan,
      months: PLAN_CATALOG[plan].months,
      amount: PLAN_CATALOG[plan].amount,
      currency: "THB",
      status: SESSION_STATUS.WAITING_PAYMENT,
      expiresAt,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };
    await docRef.set(payload);
    await auditLog({ userId, eventType: AUDIT_EVENTS.PAYMENT_SESSION_CREATED, paymentSessionId: docRef.id, metadata: { referenceId: payload.referenceId, amount: payload.amount, plan } });
    return { session: { id: docRef.id, ...payload, expiresAt }, reused: false };
  }

  async function getById(sessionId) {
    const snap = await paymentSessions.doc(sessionId).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  }

  /** ตรวจสอบว่า session ยังใช้ได้ (ยังไม่หมดอายุ, ยังไม่ถูกใช้, เป็นของ user นี้จริง) ก่อนสร้าง upload_session */
  async function validateForUpload(sessionId, userId) {
    const session = await getById(sessionId);
    if (!session) return { ok: false, reason: "NOT_FOUND" };
    if (String(session.userId) !== String(userId)) return { ok: false, reason: "USER_MISMATCH" };
    if (session.status !== SESSION_STATUS.WAITING_PAYMENT) return { ok: false, reason: "ALREADY_CONSUMED" };
    if (isExpired(toDate(session.expiresAt))) return { ok: false, reason: "EXPIRED" };
    return { ok: true, session };
  }

  /** ทำเครื่องหมายว่าใช้ session นี้ไปแล้ว (atomic ผ่าน transaction กันสองคำขอ consume พร้อมกัน) */
  async function consume(sessionId) {
    const ref = paymentSessions.doc(sessionId);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const data = snap.data();
      if (data.status !== SESSION_STATUS.WAITING_PAYMENT) return false;
      tx.set(ref, { status: SESSION_STATUS.CONSUMED, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return true;
    });
  }

  return { PREMIUM_PRICE_THB, PLAN_CATALOG, createOrReuse, findActiveSession, getById, validateForUpload, consume };
}
