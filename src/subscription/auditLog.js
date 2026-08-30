// Audit log: บันทึกเหตุการณ์สำคัญของระบบ payment/subscription (ดู spec §22)
// ห้าม log secret/token/api key ใด ๆ — เก็บเฉพาะ id, event, status, timestamp, metadata ที่จำเป็น

export const AUDIT_EVENTS = Object.freeze({
  USER_REGISTERED: "USER_REGISTERED",
  PREMIUM_REQUESTED: "PREMIUM_REQUESTED",
  PAYMENT_SESSION_CREATED: "PAYMENT_SESSION_CREATED",
  QR_CREATED: "QR_CREATED",
  SLIP_RECEIVED: "SLIP_RECEIVED",
  SLIP_VERIFICATION_STARTED: "SLIP_VERIFICATION_STARTED",
  PAYMENT_VERIFIED: "PAYMENT_VERIFIED",
  PAYMENT_REJECTED: "PAYMENT_REJECTED",
  PAYMENT_PENDING_REVIEW: "PAYMENT_PENDING_REVIEW",
  PREMIUM_ACTIVATED: "PREMIUM_ACTIVATED",
  PREMIUM_EXPIRED: "PREMIUM_EXPIRED",
  PREMIUM_RENEWED: "PREMIUM_RENEWED",
  DUPLICATE_TRANSACTION: "DUPLICATE_TRANSACTION",
  WEBHOOK_RECEIVED: "WEBHOOK_RECEIVED",
  WEBHOOK_REPLAY: "WEBHOOK_REPLAY",
  ADMIN_APPROVED: "ADMIN_APPROVED",
  ADMIN_REJECTED: "ADMIN_REJECTED",
  PREMIUM_CANCELLED_BY_ADMIN: "PREMIUM_CANCELLED_BY_ADMIN",
  GROUP_JOIN_PENDING: "GROUP_JOIN_PENDING",
  GROUP_LINKED: "GROUP_LINKED",
  GROUP_LINK_REJECTED: "GROUP_LINK_REJECTED",
  GROUP_LEFT: "GROUP_LEFT",
  GROUP_DEBT_ADDED: "GROUP_DEBT_ADDED",
  GROUP_DEBT_CLEARED: "GROUP_DEBT_CLEARED",
  GROUP_RECONFIRM_ASKED: "GROUP_RECONFIRM_ASKED",
  GROUP_RECONFIRMED: "GROUP_RECONFIRMED",
  GROUP_RECONFIRM_DECLINED: "GROUP_RECONFIRM_DECLINED"
});

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") return {};
  const forbidden = /secret|token|password|api[_-]?key|authorization/i;
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !forbidden.test(key)).slice(0, 20));
}

export function createAuditLogger({ auditLogs, FieldValue }) {
  return async function logEvent({ userId = null, eventType, paymentSessionId = null, transactionReference = null, metadata = {} } = {}) {
    if (!eventType || !Object.hasOwn(AUDIT_EVENTS, eventType)) throw new Error(`Unknown audit event type: ${eventType}`);
    try {
      await auditLogs.add({
        userId,
        eventType,
        paymentSessionId,
        transactionReference,
        metadata: sanitizeMetadata(metadata),
        createdAt: FieldValue.serverTimestamp()
      });
    } catch (error) {
      // Audit log ต้องไม่ทำให้ flow หลักพัง แต่ต้องเห็นใน console เสมอ
      console.error("audit log write failed:", error.message);
    }
  };
}
