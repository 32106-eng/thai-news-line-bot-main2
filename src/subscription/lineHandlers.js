import { formatThaiDate, daysRemaining } from "../shared/time.js";
import { readSlip } from "./ocr.js";
import { TX_STATUS } from "./paymentTransactions.js";
import { AUDIT_EVENTS } from "./auditLog.js";

// ตัวช่วยฟอร์แมตจำนวนเงินในไฟล์นี้เอง (ไม่ import จาก index.js เพราะ index.js เป็นฝั่งที่ import ไฟล์นี้อยู่แล้ว — import ย้อนกลับจะเกิด circular import)
function money(value) { return new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2 }).format(value); }
const PLAN_LABEL = { MONTHLY: "เดือน", YEARLY: "ปี" }; // ใช้แสดงในข้อความ "Premium ราคา X บาท / <label>"

// เทียบชื่อบัญชี LINE กับชื่อผู้โอนที่อ่านได้จากสลิปแบบหยาบ ๆ (เหมือนกับที่ src/admin/dashboard.html ใช้เตือนแอดมิน)
// จุดประสงค์คือให้ผู้ใช้เองก็เห็นทันทีในแชทถ้าโอนผิดบัญชี/สลิปคนละคน ไม่ต้องรอแอดมินตรวจแล้วมาทักทีหลัง
function normalizeName(s) {
  return String(s ?? "")
    .replace(/^(นาย|นาง|นางสาว|น\.ส\.|ด\.ช\.|ด\.ญ\.|mr\.?|mrs\.?|ms\.?|miss)\s*/i, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}
function namesLikelyMatch(a, b) {
  if (!a || !b) return null;
  const na = normalizeName(a), nb = normalizeName(b);
  if (!na || !nb) return null;
  return na === nb || na.includes(nb) || nb.includes(na);
}

const MSG = {
  alreadyPremium: (sub) =>
    `Premium ของคุณยังใช้งานได้ ✅\n\nเริ่มใช้งาน:\n${formatThaiDate(sub.startedAt)}\n\nหมดอายุ:\n${formatThaiDate(sub.expiresAt)}\n(เหลืออีก ${daysRemaining(sub.expiresAt)} วัน)`,
  qrUnavailable: (note) => `ยังไม่สามารถสร้าง QR ชำระเงินได้ในขณะนี้\n(${note})\nกรุณาติดต่อผู้ดูแลระบบ`,
  // planLabel/unitLabel มาจาก plan ที่เลือกจริง (ดู PLAN_CATALOG ใน paymentSessions.js) ไม่ hardcode "50 บาท/เดือน" ตายตัวอีกต่อไป เพราะตอนนี้ขายได้ทั้งรายเดือน/รายปี
  qrCreated: (session, planLabel) =>
    `Premium ราคา ${money(session.amount)} บาท / ${planLabel} 💳\n\nเลขอ้างอิง: ${session.referenceId}\n\nกรุณาชำระเงินตาม QR ด้านบน\n\nหลังชำระเงินแล้วพิมพ์:\n"ส่งสลิป"\n\n(ลิงก์/QR นี้จะหมดอายุใน 20 นาที)`,
  askForSlip: "กรุณาส่งรูปสลิปการชำระเงิน 🧾",
  noActiveSession: "ยังไม่มีรายการรอชำระเงิน กรุณาพิมพ์ \"สมัครพรีเมียม\" ก่อน",
  sessionExpired: "รายการชำระเงินหมดอายุแล้ว กรุณาพิมพ์ \"สมัครพรีเมียม\" ใหม่อีกครั้ง",
  sessionUserMismatch: "ไม่พบรายการชำระเงินนี้สำหรับบัญชีของคุณ",
  sessionAlreadyConsumed: "รายการนี้ถูกใช้ไปแล้ว กรุณาพิมพ์ \"สมัครพรีเมียม\" ใหม่หากต้องการสมัครอีกครั้ง",
  verifying: "กำลังตรวจสอบการชำระเงิน กรุณารอสักครู่... ⏳",
  verified: "ชำระเงินสำเร็จ 🎉 ตอนนี้คุณเป็นสมาชิก Premium แล้ว",
  pendingReview: "ได้รับสลิปแล้ว ระบบกำลังตรวจสอบเพิ่มเติม เจ้าหน้าที่จะยืนยันให้เร็วที่สุด กรุณารอการแจ้งเตือนอีกครั้ง 🙏",
  rejected: "ไม่สามารถยืนยันการชำระเงินได้ กรุณาตรวจสอบสลิปและลองใหม่อีกครั้ง",
  duplicate: "สลิปนี้ถูกใช้งานไปแล้ว",
  ocrUnreadable: "อ่านข้อมูลจากสลิปนี้ไม่ได้ ลองถ่ายให้เห็นยอดเงินและเลขอ้างอิงชัด ๆ อีกครั้ง",
  premiumOnly: "ฟีเจอร์นี้ใช้ได้เฉพาะ Premium เท่านั้น\n\nพิมพ์ \"สมัครพรีเมียม\" เพื่อสมัครสมาชิก (50 บาท/เดือน)",
  imageApiSlow: "กำลังประมวลผล กรุณารอสักครู่...",
  imageApiError: "ระบบประมวลผลภาพใช้เวลานานกว่าปกติ กรุณาลองใหม่อีกครั้ง"
};

export function createSubscriptionLineHandlers({
  subscriptionService,
  paymentSessionService,
  uploadSessionService,
  paymentTransactionService,
  richMenuService,
  qrService,
  auditLog,
  ai,
  visionModel,
  buildQrImageUrl,
  getLineDisplayName
}) {
  // คืนบรรทัดเสริมท้ายข้อความแจ้งผล (ว่างเปล่าถ้าข้อมูลไม่พอเทียบ เพื่อไม่ให้ข้อความรกเกินจำเป็นตอนอ่านสลิปไม่ครบ)
  async function buildNameCheckLine(userId, senderName) {
    if (!getLineDisplayName || !senderName) return "";
    const accountName = await getLineDisplayName(userId).catch(() => null);
    const match = namesLikelyMatch(accountName, senderName);
    if (match === false) return `\n\n⚠ ชื่อบัญชี LINE ของคุณ (${accountName}) กับชื่อผู้โอนในสลิป (${senderName}) ดูไม่ตรงกัน ถ้าโอนจากบัญชีคนอื่นให้แจ้งเจ้าหน้าที่ด้วยนะ ไม่งั้นอาจไม่ผ่านการตรวจสอบ`;
    if (match === true) return `\n\nชื่อผู้โอน (${senderName}) ตรงกับบัญชีที่สมัคร ✅`;
    return ""; // match === null: ข้อมูลไม่พอเทียบ ไม่ต้องพูดอะไรเพิ่ม กันข้อความดูน่ากังวลเกินจริงทั้งที่แค่อ่านชื่อไม่ครบ
  }

  // เดิม handleSubscribeCommand สร้าง session รายเดือนทันที ตอนนี้แยกเป็น 2 ขั้น:
  // 1) handleSubscribeCommand แค่เช็คว่า active อยู่แล้วหรือยัง ถ้ายัง -> ให้ index.js โชว์การ์ดเลือกแผน (planPickerFlexMessage)
  // 2) handlePlanSelected สร้าง session จริงหลังผู้ใช้กดเลือกแผนจากการ์ด (ดู postback handler ใน index.js)
  async function handleSubscribeCommand(userId) {
    const status = await subscriptionService.getStatusView(userId);
    await auditLog({ userId, eventType: AUDIT_EVENTS.PREMIUM_REQUESTED });
    if (status.active) return { alreadyPremium: true, text: MSG.alreadyPremium(status) };
    return { alreadyPremium: false };
  }

  async function handlePlanSelected(userId, planKey) {
    const status = await subscriptionService.getStatusView(userId);
    if (status.active) return { text: MSG.alreadyPremium(status) };

    const { session } = await paymentSessionService.createOrReuse(userId, planKey);
    const qr = qrService.generateForSession(session);
    if (!qr.available) return { text: MSG.qrUnavailable(qr.note) };
    await auditLog({ userId, eventType: AUDIT_EVENTS.QR_CREATED, paymentSessionId: session.id, metadata: { referenceId: session.referenceId, plan: session.plan } });
    const qrImageUrl = buildQrImageUrl ? buildQrImageUrl(session.id) : null;
    const planLabel = PLAN_LABEL[session.plan] ?? PLAN_LABEL.MONTHLY;
    return { text: MSG.qrCreated(session, planLabel), qrImageUrl };
  }

  async function handleSendSlipCommand(userId) {
    // "ส่งสลิป" ต้องมี payment_session ที่เปิดไว้แล้วเท่านั้น (จากตอนพิมพ์ "สมัครพรีเมียม")
    // ห้ามสร้าง session ใหม่ตรงนี้ ไม่งั้นจะเป็นการเปิดช่องให้ข้ามขั้นตอนชำระเงิน
    const active = await paymentSessionService.findActiveSession(userId);
    if (!active) return MSG.noActiveSession;
    await uploadSessionService.open({ userId, paymentSessionId: active.id });
    return MSG.askForSlip;
  }

  /**
   * options.isPremiumOverride: ใช้เมื่อ userId คือ groupId/roomId (กลุ่มจดบัญชี) —
   * สิทธิ์ Premium ของ "รูปที่ส่งเข้ากลุ่ม" ต้องอิงจาก groupLinkService.isPremiumGroup(groupId)
   * ที่ index.js เช็คมาให้แล้ว ไม่ใช่ subscriptionService.isPremium(groupId) ตรง ๆ
   * (groupId ไม่มี subscription เป็นของตัวเอง — Premium ผูกกับ owner ของกลุ่มเท่านั้น)
   * ถ้าไม่ส่ง option นี้มา (undefined) จะ fallback ไปเช็คแบบเดิม คือ subscriptionService.isPremium(userId)
   */
  async function handleReceiptOrSlipImage(userId, downloadImage, options = {}) {
    // 1) ถ้ามี upload_session ที่รอสลิปอยู่ -> ตีความรูปนี้เป็น "สลิปการชำระเงิน" ก่อนเสมอ
    const pendingUpload = await uploadSessionService.findWaitingForUser(userId);
    if (pendingUpload) return handleSlipImage(userId, pendingUpload, downloadImage);

    // 2) ไม่งั้นตีความเป็น "รูปใบเสร็จ" ของฟีเจอร์บันทึกบัญชี (ต้อง Premium)
    const isPremium = options.isPremiumOverride !== undefined ? options.isPremiumOverride : await subscriptionService.isPremium(userId);
    if (!isPremium) return { type: "premium_denied", message: MSG.premiumOnly };
    return { type: "receipt", isPremium: true };
  }

  async function handleSlipImage(userId, uploadSession, downloadImage) {
    const validation = await paymentSessionService.validateForUpload(uploadSession.paymentSessionId, userId);
    if (!validation.ok) {
      const reasonMsg = { EXPIRED: MSG.sessionExpired, USER_MISMATCH: MSG.sessionUserMismatch, ALREADY_CONSUMED: MSG.sessionAlreadyConsumed, NOT_FOUND: MSG.noActiveSession }[validation.reason] ?? MSG.noActiveSession;
      return { type: "slip", message: reasonMsg };
    }

    const claimed = await uploadSessionService.claimForProcessing(uploadSession.id);
    if (!claimed) return { type: "slip", message: MSG.duplicate };

    await auditLog({ userId, eventType: AUDIT_EVENTS.SLIP_RECEIVED, paymentSessionId: validation.session.id });

    let ocrData = null;
    try {
      const { mime, base64 } = await downloadImage();
      ocrData = await readSlip(ai, visionModel, mime, base64);
    } catch (error) {
      console.error("Slip image download/OCR failed:", error.message);
      await uploadSessionService.reopen(uploadSession.id);
      return { type: "slip", message: MSG.imageApiError };
    }

    if (!ocrData) {
      await uploadSessionService.reopen(uploadSession.id);
      return { type: "slip", message: MSG.ocrUnreadable };
    }

    const result = await paymentTransactionService.submitAndVerify({ userId, paymentSession: validation.session, ocrData });
    await paymentSessionService.consume(validation.session.id);
    await uploadSessionService.markDone(uploadSession.id);

    const messages = {
      [TX_STATUS.VERIFIED]: MSG.verified,
      [TX_STATUS.PENDING_REVIEW]: MSG.pendingReview,
      [TX_STATUS.REJECTED]: MSG.rejected,
      [TX_STATUS.DUPLICATE]: MSG.duplicate
    };
    let message = messages[result.outcome] ?? MSG.rejected;
    // ต่อท้ายด้วยผลเทียบชื่อบัญชี LINE กับชื่อผู้โอนในสลิป เฉพาะตอนที่ยืนยัน/รอตรวจสอบ (REJECTED/DUPLICATE ไม่เกี่ยวกับชื่อ ไม่ต้องแปะ)
    if (result.outcome === TX_STATUS.VERIFIED || result.outcome === TX_STATUS.PENDING_REVIEW) {
      message += await buildNameCheckLine(userId, ocrData.senderName);
    }

    if (result.outcome === TX_STATUS.VERIFIED) {
      await richMenuService.switchTo(userId, "PREMIUM");
    }

    return { type: "slip", message };
  }

  return { handleSubscribeCommand, handlePlanSelected, handleSendSlipCommand, handleReceiptOrSlipImage, MSG };
}

