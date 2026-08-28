import { toDate } from "./db.js";
import { addMonths, now, isExpired } from "../shared/time.js";
import { AUDIT_EVENTS } from "./auditLog.js";

export const PLAN = Object.freeze({ FREE: "FREE", PREMIUM: "PREMIUM" });
export const SUB_STATUS = Object.freeze({ ACTIVE: "ACTIVE", EXPIRED: "EXPIRED", NONE: "NONE" });

export function createSubscriptionService({ subscriptions, FieldValue, db }, auditLog) {
  /** โหลด subscription ปัจจุบันของ user ตรง ๆ จาก DB (ไม่เชื่อ cache/client) */
  async function getRaw(userId) {
    const snap = await subscriptions.doc(String(userId)).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  }

  /**
   * ตรวจสอบสิทธิ์ Premium แบบสด ๆ ทุกครั้ง
   * กฎ: status === ACTIVE AND expires_at > เวลาปัจจุบันของ server เท่านั้น
   * ห้ามเชื่อ field "premium" หรือค่าใด ๆ จาก client
   */
  async function isPremium(userId) {
    const sub = await getRaw(userId);
    if (!sub || sub.status !== SUB_STATUS.ACTIVE) return false;
    const expiresAt = toDate(sub.expiresAt);
    return !isExpired(expiresAt);
  }

  /** สถานะสำหรับแสดงผลให้ user (ข้อความ "สมัครพรีเมียม" ตอนที่ user เป็น Premium อยู่แล้ว) */
  async function getStatusView(userId) {
    const sub = await getRaw(userId);
    if (!sub) return { plan: PLAN.FREE, active: false };
    const expiresAt = toDate(sub.expiresAt);
    const active = sub.status === SUB_STATUS.ACTIVE && !isExpired(expiresAt);
    return {
      plan: active ? PLAN.PREMIUM : PLAN.FREE,
      active,
      startedAt: toDate(sub.startedAt),
      expiresAt
    };
  }

  /**
   * เปิด/ต่ออายุ Premium แบบ atomic ผ่าน Firestore transaction
   * renewal rule (spec §14): ถ้ายัง ACTIVE อยู่ -> expiry เดิม + months, ไม่งั้น -> ตอนนี้ + months
   * months มาจากแผนที่จ่ายจริง (ดู PLAN_CATALOG ใน paymentSessions.js) ค่าเริ่มต้น 1 เดือน
   * เพื่อไม่ให้โค้ดเก่าที่เรียกไม่ส่ง months มา (ถ้ามี) พังไป
   * เรียกได้เฉพาะตอน payment ผ่านการ verify แล้วเท่านั้น (ดู paymentTransactions.js)
   */
  async function activateOrRenew({ userId, paymentTransactionId, months = 1 }) {
    const ref = subscriptions.doc(String(userId));
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists ? snap.data() : null;
      const currentExpiry = current ? toDate(current.expiresAt) : null;
      const stillActive = current?.status === SUB_STATUS.ACTIVE && currentExpiry && !isExpired(currentExpiry);
      const base = stillActive ? currentExpiry : now();
      const newExpiry = addMonths(base, months);
      const wasRenewal = Boolean(stillActive);
      tx.set(ref, {
        plan: PLAN.PREMIUM,
        status: SUB_STATUS.ACTIVE,
        // startedAt ต้องผูกกับ stillActive เดียวกับที่ใช้คำนวณ newExpiry — ถ้าไม่ใช่การต่ออายุ (สมัครใหม่ตั้งแต่ต้น
        // เช่นหลังแอดมินยกเลิกไปแล้ว) ต้องรีเซ็ตเป็นตอนนี้ ไม่งั้นวันที่เริ่มเดิมจะค้างอยู่ทั้งที่หมดอายุ/ยกเลิกไปแล้วจริง ๆ
        startedAt: stillActive ? current.startedAt : FieldValue.serverTimestamp(),
        expiresAt: newExpiry,
        paymentTransactionId,
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      return { newExpiry, wasRenewal };
    });
    await auditLog({
      userId,
      eventType: result.wasRenewal ? AUDIT_EVENTS.PREMIUM_RENEWED : AUDIT_EVENTS.PREMIUM_ACTIVATED,
      transactionReference: paymentTransactionId,
      metadata: { expiresAt: result.newExpiry.toISOString() }
    });
    return result;
  }

  /**
   * แอดมินยกเลิก Premium ของ user คนใดก็ได้ทันที
   * ตั้ง status เป็น EXPIRED และเคลียร์ expiresAt ให้เป็นอดีต เพื่อไม่ให้ isPremium() ผ่านอีก
   * เรียกได้เฉพาะผ่าน requireAdmin middleware เท่านั้น (ดู admin/routes.js)
   */
  async function adminCancel({ userId, adminUsername, reason = null }) {
    const ref = subscriptions.doc(String(userId));
    const snap = await ref.get();
    if (!snap.exists) return { ok: false, reason: "ไม่พบ subscription ของ user นี้" };
    const current = snap.data();
    if (current.status !== SUB_STATUS.ACTIVE) {
      return { ok: false, reason: "user นี้ไม่ได้เป็น Premium อยู่แล้ว" };
    }
    await ref.set({ status: SUB_STATUS.EXPIRED, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await auditLog({
      userId,
      eventType: AUDIT_EVENTS.PREMIUM_CANCELLED_BY_ADMIN,
      metadata: { adminUsername, reason: reason ?? "manual_cancel" }
    });
    return { ok: true };
  }

  /** ใช้โดย cron หรือ lazily เมื่อพบว่าหมดอายุระหว่างเช็คสิทธิ์ เพื่ออัปเดตสถานะให้ตรง (ไม่ใช่ตัวตัดสินสิทธิ์หลัก) */
  async function markExpiredIfNeeded(userId) {
    const sub = await getRaw(userId);
    if (!sub || sub.status !== SUB_STATUS.ACTIVE) return false;
    const expiresAt = toDate(sub.expiresAt);
    if (!isExpired(expiresAt)) return false;
    await subscriptions.doc(String(userId)).set({ status: SUB_STATUS.EXPIRED, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await auditLog({ userId, eventType: AUDIT_EVENTS.PREMIUM_EXPIRED });
    return true;
  }

  /** สำหรับ cron: กวาดทุก subscription ที่ ACTIVE แต่หมดอายุแล้ว มาปิดสถานะ (housekeeping, ไม่ใช่ตัวตัดสินสิทธิ์) */
  async function sweepExpired() {
    const snap = await subscriptions.where("status", "==", SUB_STATUS.ACTIVE).get();
    let expiredCount = 0;
    for (const doc of snap.docs) {
      const expiresAt = toDate(doc.data().expiresAt);
      if (isExpired(expiresAt)) {
        await doc.ref.set({ status: SUB_STATUS.EXPIRED, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        await auditLog({ userId: doc.id, eventType: AUDIT_EVENTS.PREMIUM_EXPIRED });
        expiredCount += 1;
      }
    }
    return expiredCount;
  }

  return { getRaw, isPremium, getStatusView, activateOrRenew, adminCancel, markExpiredIfNeeded, sweepExpired };
}


