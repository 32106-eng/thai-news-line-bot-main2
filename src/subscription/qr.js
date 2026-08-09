// สร้าง QR payment สำหรับ 1 payment_session โดยเฉพาะ (ผูกกับ reference_id เสมอ)
// ห้ามใช้ QR ตายตัวตัวเดียวที่ทุกคนใช้ร่วมกัน (spec §4) — QR ที่สร้างที่นี่เป็น per-session เสมอ
//
// หมายเหตุ: ไม่มี payment provider จริงต่อในสภาพแวดล้อมนี้ (ไม่มี API key ให้เชื่อม)
// ฟังก์ชันนี้เตรียม "PromptPay-style" EMV QR payload ไว้เป็นโครง — ถ้าจะใช้งานจริงต้องใส่
// PROMPTPAY_ID (เลขบัตร ปชช./เบอร์โทรร้านค้า) ใน .env และควรพิจารณาใช้ provider ที่ยืนยัน
// transaction จริงได้ (ดู paymentProvider.js) แทนการเชื่อ QR เฉย ๆ

import crypto from "node:crypto";

function crc16ccitt(payload) {
  let crc = 0xffff;
  for (const byte of Buffer.from(payload, "utf8")) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function tlv(id, value) {
  return `${id}${String(value.length).padStart(2, "0")}${value}`;
}

/**
 * สร้าง PromptPay EMV QR payload แบบ static amount
 * targetId: เบอร์โทร (0812345678) หรือเลขบัตรประชาชน 13 หลัก ของบัญชีร้านค้า/แอดมิน
 */
function buildPromptPayPayload(targetId, amount) {
  const cleaned = targetId.replace(/[^0-9]/g, "");
  const isNationalId = cleaned.length === 13;
  const formattedTarget = isNationalId ? cleaned : `0066${cleaned.replace(/^0/, "")}`;
  const merchantAccountInfo = tlv("00", "A000000677010111") + tlv(isNationalId ? "03" : "01", formattedTarget);
  let payload =
    tlv("00", "01") +
    tlv("01", "12") +
    tlv("29", merchantAccountInfo) +
    tlv("53", "764") +
    tlv("54", amount.toFixed(2)) +
    tlv("58", "TH");
  payload += "6304";
  return payload + crc16ccitt(payload);
}

export function createQrService() {
  const promptPayId = process.env.PROMPTPAY_ID ?? "";

  /**
   * คืนข้อมูล QR สำหรับ payment session หนึ่งรายการ
   * ถ้าไม่ได้ตั้ง PROMPTPAY_ID ไว้ จะคืน payload = null พร้อม note ให้ผู้ดูแลระบบตั้งค่า
   * (ไม่ auto-fallback ไปสร้าง QR ปลอม/QR รวมที่ไม่ผูกกับ session)
   */
  function generateForSession(session) {
    if (!promptPayId) {
      return { available: false, note: "ยังไม่ได้ตั้งค่า PROMPTPAY_ID ใน .env — โปรดตั้งค่าบัญชีรับเงินก่อนเปิดใช้งานจริง" };
    }
    const payload = buildPromptPayPayload(promptPayId, session.amount);
    return {
      available: true,
      payload,                 // ใช้ generate เป็นภาพ QR ฝั่ง client/LINE (Image Message) ได้
      referenceId: session.referenceId,
      amount: session.amount,
      qrToken: crypto.createHash("sha256").update(`${session.id}:${session.referenceId}`).digest("hex").slice(0, 16)
    };
  }

  return { generateForSession };
}
