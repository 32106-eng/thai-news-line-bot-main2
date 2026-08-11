// Firestore ไม่มี UNIQUE constraint ระดับ engine เหมือน SQL
// เราจำลอง uniqueness ด้วยการตั้ง "doc ID = ค่าที่ต้องการให้ unique" แล้วเขียนด้วย
// `create()` (ผ่าน transaction.create ใน runTransaction) ซึ่งจะ throw ถ้า doc นั้นมีอยู่แล้ว
// -> ปลอดภัยจาก race condition ระดับเดียวกับ UNIQUE constraint ของ SQL

import { getFirestore, FieldValue } from "firebase-admin/firestore";

export function buildSubscriptionCollections(firebaseApp) {
  const db = getFirestore(firebaseApp);
  return {
    db,
    FieldValue,
    subscriptions: db.collection("panuan_subscriptions"),        // doc id = lineUserId
    paymentSessions: db.collection("panuan_payment_sessions"),   // doc id = auto
    paymentTransactions: db.collection("panuan_payment_transactions"), // doc id = transaction_reference
    uploadSessions: db.collection("panuan_upload_sessions"),     // doc id = auto
    webhookEvents: db.collection("panuan_webhook_events"),       // doc id = `${provider}_${eventId}`
    auditLogs: db.collection("panuan_audit_logs"),               // doc id = auto, append-only
    admins: db.collection("panuan_admins"),                      // doc id = username
    groupLinks: db.collection("panuan_group_links")              // doc id = groupId (LINE group ที่บอทถูกเชิญเข้า)
  };
}

/** แปลง Firestore Timestamp (หรือ Date/ISO string เดิม) ให้เป็น JS Date เสมอ */
export function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
