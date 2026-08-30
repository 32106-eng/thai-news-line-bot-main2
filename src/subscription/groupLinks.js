// จัดการการ "ผูกกลุ่ม LINE กับเจ้าของ Premium" (spec: กลุ่มจดบัญชี)
// กติกา: บอทจะถูกเชิญเข้ากลุ่มโดยคนที่เป็น Premium อยู่แล้ว (จ่าย 50 บาท/เดือนแบบ 1:1 ตามปกติ)
// พอเข้ากลุ่ม บอทรอให้มีคนพิมพ์ "/บอท ยืนยันเจ้าของ" ภายในเวลาที่กำหนด (ดู CONFIRM_WINDOW_MINUTES)
// ถ้าไม่มีใครยืนยัน หรือคนที่ยืนยันไม่ใช่ Premium -> บอทออกจากกลุ่มเอง (ตัดสินใจที่ index.js เรียก LINE leaveGroup)
// Premium ของกลุ่มไม่ใช่ entitlement แยก — เช็คสด ๆ ทุกครั้งจากสถานะ Premium ของ ownerId เท่านั้น (เหมือน isPremium() ของ user)
// ห้ามเชื่อ field ใด ๆ จาก client/LINE payload เป็นตัวตัดสินสิทธิ์ ต้องอิงจาก subscriptionService.isPremium(ownerId) สด ๆ เสมอ

import { toDate } from "./db.js";
import { now, addMinutes, isExpired } from "../shared/time.js";
import { AUDIT_EVENTS } from "./auditLog.js";

export const GROUP_LINK_STATUS = Object.freeze({
  PENDING: "PENDING",               // รอคนยืนยันความเป็นเจ้าของ (ยังไม่ผูกใคร)
  LINKED: "LINKED",                 // ผูกกับ ownerId แล้ว และ ownerId ยังเป็น Premium อยู่
  RECONFIRM_PENDING: "RECONFIRM_PENDING", // เคย LINKED แต่ Premium ของ owner หมดอายุแล้ว รอถามในกลุ่มว่ายังอยากให้บอทอยู่ต่อไหม
  REJECTED: "REJECTED"               // ไม่ยืนยัน/ไม่ใช่ Premium/ตอบไม่อยากให้อยู่ต่อ -> รอออกจากกลุ่ม
});

export const CONFIRM_WINDOW_MINUTES = 10;

export function createGroupLinkService({ groupLinks, FieldValue }, auditLog, subscriptionService) {
  /** โหลดสถานะ link ปัจจุบันของกลุ่มตรง ๆ จาก DB */
  async function getRaw(groupId) {
    const snap = await groupLinks.doc(String(groupId)).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  }

  /**
   * เรียกตอนบอทถูกเชิญเข้ากลุ่ม (LINE "join" event)
   * สร้าง (หรือรีเซ็ต) สถานะ PENDING พร้อม deadline สำหรับรอคนยืนยันเจ้าของ
   */
  async function startPending(groupId) {
    const deadline = addMinutes(now(), CONFIRM_WINDOW_MINUTES);
    await groupLinks.doc(String(groupId)).set({
      status: GROUP_LINK_STATUS.PENDING,
      ownerId: null,
      pendingUntil: deadline,
      joinedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    await auditLog({ userId: null, eventType: AUDIT_EVENTS.GROUP_JOIN_PENDING, metadata: { groupId, pendingUntil: deadline.toISOString() } });
    return { pendingUntil: deadline };
  }

  /**
   * เรียกตอนมีคนพิมพ์ "/บอท ยืนยันเจ้าของ" ในกลุ่ม
   * ต้องยัง PENDING และยังไม่หมดเวลา ถึงจะยืนยันได้
   * ผลลัพธ์:
   *  - ok:true  -> ผู้ยืนยันเป็น Premium จริง กลุ่มถูกผูกกับเขาแล้ว (LINKED)
   *  - ok:false, reason:"NOT_PREMIUM"     -> ผู้ยืนยันไม่ใช่ Premium (REJECTED, บอทควรออกจากกลุ่ม)
   *  - ok:false, reason:"EXPIRED"         -> เลย pendingUntil ไปแล้ว (บอทควรออกจากกลุ่ม)
   *  - ok:false, reason:"NOT_PENDING"     -> กลุ่มนี้ไม่ได้อยู่ในสถานะรอยืนยัน (เช่นผูกไปแล้ว หรือไม่มี record)
   */
  async function confirmOwner(groupId, confirmerUserId) {
    const link = await getRaw(groupId);
    if (!link || link.status !== GROUP_LINK_STATUS.PENDING) return { ok: false, reason: "NOT_PENDING" };

    const pendingUntil = toDate(link.pendingUntil);
    if (isExpired(pendingUntil)) return { ok: false, reason: "EXPIRED" };

    const confirmerIsPremium = await subscriptionService.isPremium(confirmerUserId);
    if (!confirmerIsPremium) {
      await groupLinks.doc(String(groupId)).set({ status: GROUP_LINK_STATUS.REJECTED, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await auditLog({ userId: confirmerUserId, eventType: AUDIT_EVENTS.GROUP_LINK_REJECTED, metadata: { groupId, reason: "NOT_PREMIUM" } });
      return { ok: false, reason: "NOT_PREMIUM" };
    }

    await groupLinks.doc(String(groupId)).set({
      status: GROUP_LINK_STATUS.LINKED,
      ownerId: confirmerUserId,
      pendingUntil: null,
      linkedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    await auditLog({ userId: confirmerUserId, eventType: AUDIT_EVENTS.GROUP_LINKED, metadata: { groupId } });
    return { ok: true };
  }

  /**
   * ตรวจสอบสิทธิ์ Premium ของ "กลุ่ม" แบบสด ๆ ทุกครั้ง (เหมือน subscriptionService.isPremium ของ user เดี่ยว)
   * กฎ: ต้อง LINKED (หรือ RECONFIRM_PENDING ที่เพิ่งกลับมาเป็น Premium ก่อนมีคนตอบ) และ ownerId ต้องยังเป็น Premium อยู่จริง ณ ตอนนี้
   * ถ้า owner หมดอายุ/ยกเลิก Premium ไปแล้ว กลุ่มจะหลุดสถานะ Premium ทันทีโดยไม่ต้องมี cron แยก
   * (การถามยืนยันซ้ำเมื่อหมดอายุเป็นคนละเรื่องกับ isPremiumGroup — ดู cron ที่เรียก findLinkedExpired ใน index.js)
   */
  async function isPremiumGroup(groupId) {
    const link = await getRaw(groupId);
    if (!link || ![GROUP_LINK_STATUS.LINKED, GROUP_LINK_STATUS.RECONFIRM_PENDING].includes(link.status) || !link.ownerId) return false;
    return subscriptionService.isPremium(link.ownerId);
  }

  /**
   * ใช้โดย cron: หากลุ่มที่ LINKED อยู่แต่ owner หมด Premium ไปแล้ว (สด ๆ) -> ย้ายเป็น RECONFIRM_PENDING
   * และคืนรายการกลุ่มที่ "เพิ่ง" เปลี่ยนสถานะรอบนี้ ให้ index.js ส่งข้อความถามในกลุ่มต่อ (ไม่ถามซ้ำทุกรอบ cron)
   */
  async function findNewlyExpiredLinked() {
    const snap = await groupLinks.where("status", "==", GROUP_LINK_STATUS.LINKED).get();
    const newlyExpired = [];
    for (const doc of snap.docs) {
      const link = doc.data();
      if (!link.ownerId) continue;
      const stillPremium = await subscriptionService.isPremium(link.ownerId).catch(() => false);
      if (stillPremium) continue;
      newlyExpired.push({ groupId: doc.id, ownerId: link.ownerId });
    }
    return newlyExpired;
  }

  /** เรียกทันทีหลังตรวจพบว่า owner หมด Premium — เปลี่ยนสถานะเป็น RECONFIRM_PENDING (ไม่มี deadline ตามที่ระบุ) */
  async function askReconfirm(groupId) {
    await groupLinks.doc(String(groupId)).set({
      status: GROUP_LINK_STATUS.RECONFIRM_PENDING,
      reconfirmAskedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    await auditLog({ userId: null, eventType: AUDIT_EVENTS.GROUP_RECONFIRM_ASKED, metadata: { groupId } });
  }

  /**
   * เรียกตอนมีคนพิมพ์ "/บอท ยืนยันต่อ" ในกลุ่มที่อยู่สถานะ RECONFIRM_PENDING
   * ไม่มีกำหนดเวลา (ตามที่ผู้ใช้ระบุ) แต่ผู้ยืนยันต้องเป็น Premium จริง ณ ตอนนี้ — กลายเป็นเจ้าของกลุ่มคนใหม่ได้ (ไม่จำเป็นต้องเป็นคนเดิม)
   * ผลลัพธ์: { ok:true } | { ok:false, reason:"NOT_PENDING" | "NOT_PREMIUM" }
   */
  async function reconfirmOwner(groupId, confirmerUserId) {
    const link = await getRaw(groupId);
    if (!link || link.status !== GROUP_LINK_STATUS.RECONFIRM_PENDING) return { ok: false, reason: "NOT_PENDING" };
    const confirmerIsPremium = await subscriptionService.isPremium(confirmerUserId);
    if (!confirmerIsPremium) return { ok: false, reason: "NOT_PREMIUM" };
    await groupLinks.doc(String(groupId)).set({
      status: GROUP_LINK_STATUS.LINKED,
      ownerId: confirmerUserId,
      reconfirmAskedAt: null,
      linkedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    await auditLog({ userId: confirmerUserId, eventType: AUDIT_EVENTS.GROUP_RECONFIRMED, metadata: { groupId } });
    return { ok: true };
  }

  /** เรียกตอนมีคนพิมพ์ "/บอท ยืนยันต่อ ไม่" (ปฏิเสธ) ในกลุ่มที่อยู่สถานะ RECONFIRM_PENDING -> บอทควรออกจากกลุ่ม */
  async function declineReconfirm(groupId, respondedByUserId) {
    const link = await getRaw(groupId);
    if (!link || link.status !== GROUP_LINK_STATUS.RECONFIRM_PENDING) return { ok: false, reason: "NOT_PENDING" };
    await groupLinks.doc(String(groupId)).set({ status: GROUP_LINK_STATUS.REJECTED, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await auditLog({ userId: respondedByUserId, eventType: AUDIT_EVENTS.GROUP_RECONFIRM_DECLINED, metadata: { groupId } });
    return { ok: true };
  }

  /** ใช้โดย cron: หา groupId ที่ค้างอยู่ใน PENDING เกินเวลาแล้ว เพื่อสั่งให้บอทออกจากกลุ่ม */
  async function findExpiredPending() {
    const snap = await groupLinks.where("status", "==", GROUP_LINK_STATUS.PENDING).get();
    const expired = [];
    for (const doc of snap.docs) {
      const pendingUntil = toDate(doc.data().pendingUntil);
      if (isExpired(pendingUntil)) expired.push(doc.id);
    }
    return expired;
  }

  /** เรียกหลังบอทออกจากกลุ่มแล้ว (ไม่ว่าจะเพราะ REJECTED หรือ EXPIRED) เพื่อเคลียร์ record */
  async function markLeft(groupId) {
    await groupLinks.doc(String(groupId)).set({ status: GROUP_LINK_STATUS.REJECTED, pendingUntil: null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await auditLog({ userId: null, eventType: AUDIT_EVENTS.GROUP_LEFT, metadata: { groupId } });
  }

  /** เรียกตอนบอทถูกเตะ/ออกจากกลุ่มเอง (LINE "leave" event) เพื่อลบสถานะ link ทิ้ง */
  async function removeLink(groupId) {
    await groupLinks.doc(String(groupId)).delete();
  }

  // --- รอรับรูปใบเสร็จในกลุ่ม (คนละเรื่องกับ uploadSessionService ที่ใช้เฉพาะ "สลิปจ่ายเงิน Premium") ---
  // กลุ่มไม่มี payment_session ให้ผูก จึงใช้ field ธรรมดาบน group_links doc เอง เก็บแค่ "รอรูปจากใครถึงเมื่อไหร่"
  const RECEIPT_WAIT_MINUTES = 5;

  /** เรียกตอนมีคนพิมพ์ "/บอท สลิป" ในกลุ่มที่เป็น Premium อยู่แล้ว เพื่อรอรับรูปใบเสร็จถัดไปจากคนนั้น */
  async function openReceiptWait(groupId, requestedByUserId) {
    const expiresAt = addMinutes(now(), RECEIPT_WAIT_MINUTES);
    await groupLinks.doc(String(groupId)).set({
      pendingReceiptFrom: requestedByUserId,
      pendingReceiptUntil: expiresAt,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return { expiresAt };
  }

  /** เรียกตอนรูปมาถึง webhook: เช็คว่ากลุ่มนี้กำลังรอรูปจากคนที่ส่งมาจริงไหม และยังไม่หมดเวลา */
  async function consumeReceiptWait(groupId, senderUserId) {
    const link = await getRaw(groupId);
    if (!link?.pendingReceiptFrom) return false;
    if (String(link.pendingReceiptFrom) !== String(senderUserId)) return false;
    if (isExpired(toDate(link.pendingReceiptUntil))) return false;
    await groupLinks.doc(String(groupId)).set({ pendingReceiptFrom: null, pendingReceiptUntil: null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  }

  return { getRaw, startPending, confirmOwner, isPremiumGroup, findExpiredPending, markLeft, removeLink, openReceiptWait, consumeReceiptWait, findNewlyExpiredLinked, askReconfirm, reconfirmOwner, declineReconfirm };
}
