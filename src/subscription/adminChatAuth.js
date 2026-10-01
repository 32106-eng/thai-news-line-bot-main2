// สถานะ "รอรหัสผ่านแอดมิน" ชั่วคราว — พิมพ์ "แอดมิน" ในแชท 1:1 กับบอทแล้วบอทจะถามรหัสผ่าน (ดู index.js)
// ข้อความถัดไปจากคนเดิมจะถูกตีความเป็นรหัสผ่านเสมอ (ไม่ว่าจะถูกหรือผิด) แล้วเคลียร์สถานะทิ้งทันที
// กันไม่ให้เดารหัสวนซ้ำในหน้าต่างเดิม (ต้องพิมพ์ "แอดมิน" ใหม่ทุกครั้งถ้าพิมพ์รหัสผิด)
//
// รหัสผ่านชุดนี้เป็นรหัสร่วมตัวเดียว (ตั้งค่าที่ ADMIN_CHAT_PASSWORD ใน .env) คนละชุดกับ /admin เว็บ
// (username+password hash เฉพาะคน + signed cookie — ดู admin/auth.js) ใช้แค่กันคนทั่วไปเรียกดูสรุปโทเค็นผ่านแชทเฉย ๆ
// ไม่ใช่ auth หลักของระบบ Premium/Payment

import { toDate } from "./db.js";
import { now, addMinutes, isExpired } from "../shared/time.js";

const PENDING_TTL_MINUTES = 2;

export function createAdminChatAuthService({ adminChatAuth, FieldValue }) {
  async function startPending(userId) {
    await adminChatAuth.doc(String(userId)).set({
      pendingUntil: addMinutes(now(), PENDING_TTL_MINUTES),
      updatedAt: FieldValue.serverTimestamp()
    });
  }

  /** เช็คว่ากำลังรอรหัสผ่านจากคนนี้อยู่ไหม (และยังไม่หมดเวลา) — ไม่ consume ทิ้ง */
  async function isPending(userId) {
    const snap = await adminChatAuth.doc(String(userId)).get();
    if (!snap.exists) return false;
    return !isExpired(toDate(snap.data().pendingUntil));
  }

  /** เคลียร์สถานะทิ้งเสมอหลังอ่านข้อความถัดไปของคนนี้แล้ว ไม่ว่ารหัสจะถูกหรือผิด */
  async function consume(userId) {
    await adminChatAuth.doc(String(userId)).delete();
  }

  return { startPending, isPending, consume };
}
