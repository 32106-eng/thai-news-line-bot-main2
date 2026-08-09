import { formatThaiDate, daysRemaining } from "../shared/time.js";
import { readSlip } from "./ocr.js";
import { TX_STATUS } from "./paymentTransactions.js";
import { AUDIT_EVENTS } from "./auditLog.js";

const MSG = {
  alreadyPremium: (sub) =>
    `Premium ของคุณยังใช้งานได้ ✅\n\nเริ่มใช้งาน:\n${formatThaiDate(sub.startedAt)}\n\nหมดอายุ:\n${formatThaiDate(sub.expiresAt)}\n(เหลืออีก ${daysRemaining(sub.expiresAt)} วัน)`,
  qrUnavailable: (note) => `ยังไม่สามารถสร้าง QR ชำระเงินได้ในขณะนี้\n(${note})\nกรุณาติดต่อผู้ดูแลระบบ`,
  qrCreated: (session) =>
    `Premium ราคา 50 บาท / เดือน 💳\n\nเลขอ้างอิง: ${session.referenceId}\n\nกรุณาชำระเงินตาม QR ด้านบน\n\nหลังชำระเงินแล้วพิมพ์:\n"ส่งสลิป"\n\n(ลิงก์/QR นี้จะหมดอายุใน 20 นาที)`,
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
  buildQrImageUrl
}) {
  async function handleSubscribeCommand(userId) {
    const status = await subscriptionService.getStatusView(userId);
    await auditLog({ userId, eventType: AUDIT_EVENTS.PREMIUM_REQUESTED });
    if (status.active) return { text: MSG.alreadyPremium(status) };

    const { session } = await paymentSessionService.createOrReuse(userId);
    const qr = qrService.generateForSession(session);
    if (!qr.available) return { text: MSG.qrUnavailable(qr.note) };
    await auditLog({ userId, eventType: AUDIT_EVENTS.QR_CREATED, paymentSessionId: session.id, metadata: { referenceId: session.referenceId } });
    // ส่ง Image Message ที่ render จาก qr.payload เป็นภาพ QR จริง (ผ่าน /qr/:sessionId.png ใน index.js)
    // ร่วมกับข้อความนี้ — ถ้าไม่ได้ตั้ง PUBLIC_BASE_URL จะไม่มี qrImageUrl ให้ และข้อความอย่างเดียวจะถูกส่งไปแทน
    const qrImageUrl = buildQrImageUrl ? buildQrImageUrl(session.id) : null;
    return { text: MSG.qrCreated(session), qrImageUrl };
  }

  async function handleSendSlipCommand(userId) {
    // "ส่งสลิป" ต้องมี payment_session ที่เปิดไว้แล้วเท่านั้น (จากตอนพิมพ์ "สมัครพรีเมียม")
    // ห้ามสร้าง session ใหม่ตรงนี้ ไม่งั้นจะเป็นการเปิดช่องให้ข้ามขั้นตอนชำระเงิน
    const active = await paymentSessionService.findActiveSession(userId);
    if (!active) return MSG.noActiveSession;
    await uploadSessionService.open({ userId, paymentSessionId: active.id });
    return MSG.askForSlip;
  }

  async function handleReceiptOrSlipImage(userId, downloadImage) {
    // 1) ถ้ามี upload_session ที่รอสลิปอยู่ -> ตีความรูปนี้เป็น "สลิปการชำระเงิน" ก่อนเสมอ
    const pendingUpload = await uploadSessionService.findWaitingForUser(userId);
    if (pendingUpload) return handleSlipImage(userId, pendingUpload, downloadImage);

    // 2) ไม่งั้นตีความเป็น "รูปใบเสร็จ" ของฟีเจอร์บันทึกบัญชี (ต้อง Premium)
    const isPremium = await subscriptionService.isPremium(userId);
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
    const message = messages[result.outcome] ?? MSG.rejected;

    if (result.outcome === TX_STATUS.VERIFIED) {
      await richMenuService.switchTo(userId, "PREMIUM");
    }

    return { type: "slip", message };
  }

  return { handleSubscribeCommand, handleSendSlipCommand, handleReceiptOrSlipImage, MSG };
}
