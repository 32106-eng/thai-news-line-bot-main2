import { toDate } from "./db.js";
import { AUDIT_EVENTS } from "./auditLog.js";

export const TX_STATUS = Object.freeze({
  VERIFYING: "VERIFYING",
  PENDING_REVIEW: "PENDING_REVIEW",
  VERIFIED: "VERIFIED",
  REJECTED: "REJECTED",
  DUPLICATE: "DUPLICATE"
});

/**
 * ผลลัพธ์ที่ handler (lineHandlers.js) ใช้ตัดสินใจว่าจะตอบผู้ใช้ว่าอะไร
 * outcome: "VERIFIED" | "PENDING_REVIEW" | "REJECTED" | "DUPLICATE"
 */
export function createPaymentTransactionService({ paymentTransactions, FieldValue, db }, { auditLog, paymentProvider, subscriptionService }) {
  /**
   * รับสลิปที่ OCR อ่านแล้ว → พยายามตรวจสอบ transaction จริง → ตัดสินสถานะ
   * ไม่เคย auto-approve จาก OCR เพียงอย่างเดียว (spec §6, §7, §33)
   */
  async function submitAndVerify({ userId, paymentSession, ocrData }) {
    if (!ocrData || !ocrData.amount) {
      return { outcome: TX_STATUS.REJECTED, reason: "OCR_UNREADABLE" };
    }

    // ต้องมี reference บนสลิปถึงจะติดตามกัน duplicate ได้อย่างน่าเชื่อถือ
    // ถ้าไม่มี reference เลย ให้ fallback เป็น PENDING_REVIEW เสมอ (ไม่มีทางกัน replay ได้ด้วย amount อย่างเดียว)
    const rawReference = ocrData.transactionReference;
    if (!rawReference) {
      return openPendingReview({ userId, paymentSession, ocrData, reason: "NO_REFERENCE_ON_SLIP" });
    }
    const transactionReference = normalizeReference(rawReference);

    await auditLog({
      userId,
      eventType: AUDIT_EVENTS.SLIP_VERIFICATION_STARTED,
      paymentSessionId: paymentSession.id,
      transactionReference,
      metadata: { ocrAmount: ocrData.amount }
    });

    // ---- ตรวจ duplicate ก่อนเสมอ: doc ID = transactionReference บังคับ uniqueness ----
    const docRef = paymentTransactions.doc(transactionReference);
    const existing = await docRef.get();
    if (existing.exists) {
      await auditLog({ userId, eventType: AUDIT_EVENTS.DUPLICATE_TRANSACTION, paymentSessionId: paymentSession.id, transactionReference });
      return { outcome: TX_STATUS.DUPLICATE };
    }

    // ---- ตรวจจำนวนเงินขั้นต้นจาก OCR (เร็ว, กันข้อมูลผิดชัด ๆ ก่อนเรียก provider) ----
    // หมายเหตุ: การตรวจนี้ "ไม่ใช่" การอนุมัติ เป็นแค่ pre-filter — การอนุมัติจริงต้องผ่าน provider
    if (Math.abs(ocrData.amount - paymentSession.amount) > 0.01) {
      return openPendingReview({ userId, paymentSession, ocrData, reason: "AMOUNT_MISMATCH_OCR" });
    }

    // ---- พยายามตรวจสอบ transaction จริงกับ payment provider ----
    const verification = await paymentProvider.verifyTransaction({
      transactionReference,
      expectedAmount: paymentSession.amount,
      ocrData,
      paymentSession
    });

    // ---- ตอนนี้ยังไม่มี provider จริง (canVerify=false เสมอ) -> PENDING_REVIEW เสมอ ----
    if (!verification.canVerify) {
      return openPendingReview({ userId, paymentSession, ocrData, transactionReference, reason: verification.reason ?? "PROVIDER_UNAVAILABLE" });
    }

    if (!verification.verified) {
      return reject({ userId, paymentSession, ocrData, transactionReference, reason: verification.reason ?? "PROVIDER_REJECTED" });
    }

    // ---- Provider ยืนยันแล้วจริง ๆ: เขียน record แบบ atomic ด้วย transaction.create() กัน race duplicate ----
    return finalizeVerified({ userId, paymentSession, ocrData, transactionReference, verification });
  }

  function normalizeReference(raw) {
    return String(raw).trim().replace(/\s+/g, "").toUpperCase().slice(0, 120);
  }

  async function openPendingReview({ userId, paymentSession, ocrData, transactionReference, reason }) {
    const refKey = transactionReference ?? `PENDING_${paymentSession.id}_${Date.now()}`;
    const docRef = paymentTransactions.doc(refKey);
    try {
      await docRef.create({
        userId,
        paymentSessionId: paymentSession.id,
        transactionReference: refKey,
        amount: ocrData.amount,
        status: TX_STATUS.PENDING_REVIEW,
        ocrExtracted: ocrData,
        reviewReason: reason,
        paidAt: null,
        verifiedAt: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
    } catch {
      // ถ้า create ชนกัน (เช่นสองคำขอพร้อมกัน สร้าง PENDING key เดียวกัน) ถือว่า duplicate เช่นกัน
      await auditLog({ userId, eventType: AUDIT_EVENTS.DUPLICATE_TRANSACTION, paymentSessionId: paymentSession.id, transactionReference: refKey });
      return { outcome: TX_STATUS.DUPLICATE };
    }
    await auditLog({ userId, eventType: AUDIT_EVENTS.PAYMENT_PENDING_REVIEW, paymentSessionId: paymentSession.id, transactionReference: refKey, metadata: { reason } });
    return { outcome: TX_STATUS.PENDING_REVIEW, transactionReference: refKey };
  }

  async function reject({ userId, paymentSession, ocrData, transactionReference, reason }) {
    const docRef = paymentTransactions.doc(transactionReference);
    try {
      await docRef.create({
        userId,
        paymentSessionId: paymentSession.id,
        transactionReference,
        amount: ocrData.amount,
        status: TX_STATUS.REJECTED,
        ocrExtracted: ocrData,
        reviewReason: reason,
        paidAt: null,
        verifiedAt: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
    } catch {
      return { outcome: TX_STATUS.DUPLICATE };
    }
    await auditLog({ userId, eventType: AUDIT_EVENTS.PAYMENT_REJECTED, paymentSessionId: paymentSession.id, transactionReference, metadata: { reason } });
    return { outcome: TX_STATUS.REJECTED, reason };
  }

  async function finalizeVerified({ userId, paymentSession, ocrData, transactionReference, verification }) {
    const docRef = paymentTransactions.doc(transactionReference);
    try {
      await docRef.create({
        userId,
        paymentSessionId: paymentSession.id,
        transactionReference,
        amount: verification.amount ?? ocrData.amount,
        status: TX_STATUS.VERIFIED,
        ocrExtracted: ocrData,
        providerVerification: { providerRef: verification.providerRef ?? null },
        paidAt: verification.paidAt ?? ocrData.paidAt ?? null,
        verifiedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
    } catch {
      await auditLog({ userId, eventType: AUDIT_EVENTS.DUPLICATE_TRANSACTION, paymentSessionId: paymentSession.id, transactionReference });
      return { outcome: TX_STATUS.DUPLICATE };
    }
    await auditLog({ userId, eventType: AUDIT_EVENTS.PAYMENT_VERIFIED, paymentSessionId: paymentSession.id, transactionReference });
    await subscriptionService.activateOrRenew({ userId, paymentTransactionId: transactionReference });
    return { outcome: TX_STATUS.VERIFIED, transactionReference };
  }

  /** ใช้โดย Admin approve flow (§24): แปลง PENDING_REVIEW -> VERIFIED และเปิด Premium ผ่าน backend เท่านั้น */
  async function adminApprove({ transactionReference, adminUsername }) {
    const ref = paymentTransactions.doc(transactionReference);
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { ok: false, reason: "NOT_FOUND" };
      const data = snap.data();
      if (data.status !== TX_STATUS.PENDING_REVIEW) return { ok: false, reason: "NOT_PENDING", currentStatus: data.status };
      tx.set(ref, { status: TX_STATUS.VERIFIED, verifiedAt: FieldValue.serverTimestamp(), reviewedBy: adminUsername, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return { ok: true, userId: data.userId };
    });
    if (!result.ok) return result;
    await auditLog({ userId: result.userId, eventType: AUDIT_EVENTS.ADMIN_APPROVED, transactionReference, metadata: { adminUsername } });
    await subscriptionService.activateOrRenew({ userId: result.userId, paymentTransactionId: transactionReference });
    return { ok: true };
  }

  async function adminReject({ transactionReference, adminUsername, reason }) {
    const ref = paymentTransactions.doc(transactionReference);
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { ok: false, reason: "NOT_FOUND" };
      const data = snap.data();
      if (data.status !== TX_STATUS.PENDING_REVIEW) return { ok: false, reason: "NOT_PENDING" };
      tx.set(ref, { status: TX_STATUS.REJECTED, reviewedBy: adminUsername, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return { ok: true, userId: data.userId };
    });
    if (!result.ok) return result;
    await auditLog({ userId: result.userId, eventType: AUDIT_EVENTS.ADMIN_REJECTED, transactionReference, metadata: { adminUsername, reason } });
    return { ok: true };
  }

  async function listPendingReview(limit = 50) {
    const snap = await paymentTransactions.where("status", "==", TX_STATUS.PENDING_REVIEW).orderBy("createdAt", "desc").limit(limit).get();
    return snap.docs.map((doc) => ({ id: doc.id, ...doc.data(), createdAt: toDate(doc.data().createdAt) }));
  }

  return { submitAndVerify, adminApprove, adminReject, listPendingReview };
}
