import { toDate } from "./db.js";
import { addMinutes, isExpired } from "../shared/time.js";

export const UPLOAD_STATUS = Object.freeze({
  WAITING_SLIP: "WAITING_SLIP",
  PROCESSING: "PROCESSING",
  DONE: "DONE",
  EXPIRED: "EXPIRED"
});

const UPLOAD_TTL_MINUTES = 15;

export function createUploadSessionService({ uploadSessions, FieldValue, db }) {
  /** เรียกตอนผู้ใช้กด "ส่งสลิป" หลัง payment_session ผ่านการ validate แล้วเท่านั้น (ดู lineHandlers.js) */
  async function open({ userId, paymentSessionId }) {
    const expiresAt = addMinutes(new Date(), UPLOAD_TTL_MINUTES);
    const ref = uploadSessions.doc();
    const payload = {
      userId,
      paymentSessionId,
      status: UPLOAD_STATUS.WAITING_SLIP,
      expiresAt,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };
    await ref.set(payload);
    return { id: ref.id, ...payload, expiresAt };
  }

  /** หา upload session ที่กำลังรอสลิปอยู่ของ user คนนี้ (ใช้ตอนรูปมาถึงจาก webhook) */
  async function findWaitingForUser(userId) {
    const snap = await uploadSessions
      .where("userId", "==", userId)
      .where("status", "==", UPLOAD_STATUS.WAITING_SLIP)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    const data = { id: doc.id, ...doc.data() };
    if (isExpired(toDate(data.expiresAt))) return null;
    return data;
  }

  /** ล็อค upload session เป็น PROCESSING แบบ atomic กันรูปซ้ำหลายใบเข้ามาพร้อมกันของ session เดียวกัน */
  async function claimForProcessing(sessionId) {
    const ref = uploadSessions.doc(sessionId);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const data = snap.data();
      if (data.status !== UPLOAD_STATUS.WAITING_SLIP) return false;
      if (isExpired(toDate(data.expiresAt))) return false;
      tx.set(ref, { status: UPLOAD_STATUS.PROCESSING, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return true;
    });
  }

  async function markDone(sessionId) {
    await uploadSessions.doc(sessionId).set({ status: UPLOAD_STATUS.DONE, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }

  /** ถ้า verification ล้มเหลว/reject ให้เปิดกลับเป็น WAITING_SLIP เพื่อให้ผู้ใช้ลองส่งใหม่ในกรอบเวลาเดิม ไม่ต้องเริ่ม flow ใหม่ */
  async function reopen(sessionId) {
    await uploadSessions.doc(sessionId).set({ status: UPLOAD_STATUS.WAITING_SLIP, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }

  return { open, findWaitingForUser, claimForProcessing, markDone, reopen };
}
