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
const PREMIUM_PRICE_THB = 50;
// กันผู้ใช้กด "สมัครพรีเมียม" รัว ๆ สร้าง session ใหม่ทุกครั้ง — ถ้ามี session ที่ยังไม่หมดอายุอยู่แล้ว ให้ใช้ตัวเดิม
const REUSE_WINDOW = true;

export function createPaymentSessionService({ paymentSessions, FieldValue, db }, auditLog) {
  function referenceId() {
    // สุ่มไม่ซ้ำในทางปฏิบัติ: 16 ไบต์สุ่ม hex + prefix เพื่ออ่านง่ายใน admin dashboard
    return `PN${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
  }

  async function findActiveSession(userId) {
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
    return data;
  }

  /** สร้าง payment session ใหม่ (หรือคืน session เดิมที่ยังไม่หมดอายุ เพื่อกัน double-submit สร้างซ้ำ) */
  async function createOrReuse(userId) {
    const existing = REUSE_WINDOW ? await findActiveSession(userId) : null;
    if (existing) return { session: existing, reused: true };

    const expiresAt = addMinutes(new Date(), SESSION_TTL_MINUTES);
    const docRef = paymentSessions.doc();
    const payload = {
      userId,
      referenceId: referenceId(),
      amount: PREMIUM_PRICE_THB,
      currency: "THB",
      status: SESSION_STATUS.WAITING_PAYMENT,
      expiresAt,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };
    await docRef.set(payload);
    await auditLog({ userId, eventType: AUDIT_EVENTS.PAYMENT_SESSION_CREATED, paymentSessionId: docRef.id, metadata: { referenceId: payload.referenceId, amount: PREMIUM_PRICE_THB } });
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

  return { PREMIUM_PRICE_THB, createOrReuse, findActiveSession, getById, validateForUpload, consume };
}
