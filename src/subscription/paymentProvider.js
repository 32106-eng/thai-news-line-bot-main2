// ============================================================================
// PaymentProvider adapter
// ============================================================================
// จุดประสงค์: แยกชั้น "ตรวจสอบธุรกรรมจริง" ออกจาก OCR โดยเด็ดขาด (spec §6, §7)
// สถานะปัจจุบัน: **ไม่มี payment provider จริงต่ออยู่** ในสภาพแวดล้อมนี้ ไม่มี API key/
// บัญชีของ PromptPay slip-verification API, Omise, 2C2P, GB Prime Pay หรือธนาคารใด ๆ ให้เชื่อม
//
// ดังนั้น NullPaymentProvider ด้านล่างจะ "ตรวจสอบไม่ได้" เสมอ (cannot-verify) ซึ่งตาม state
// machine ของระบบ (§10) หมายความว่าทุก transaction จะตกไปที่ PENDING_REVIEW ให้ Admin ตรวจสอบเอง
// — นี่คือ fallback ที่ปลอดภัยตาม spec เอง ไม่ใช่การลัดขั้นตอน
//
// วิธีเสียบ provider จริงในอนาคต:
//   1. เขียน class ใหม่ implement เมธอด verifyTransaction() ตาม signature เดียวกัน
//   2. เรียก API จริงของ provider ด้วย reference ที่ OCR อ่านได้ (หรือดีกว่าคือ Order ID ที่ผูกกับ
//      QR ตอนสร้าง หากใช้ Dynamic QR ของ provider นั้น)
//   3. คืนค่า { verified: true/false, canVerify: true, amount, receiverName, paidAt, providerRef }
//   4. สลับ export ด้านล่างจาก NullPaymentProvider เป็น provider ใหม่ ไม่ต้องแก้ paymentTransactions.js
// ============================================================================

export class NullPaymentProvider {
  /**
   * @param {object} _params - ocrData และ session context (ไม่ใช้งานใน stub นี้)
   * @returns {Promise<{verified: boolean, canVerify: boolean, reason: string}>}
   */
  // eslint-disable-next-line no-unused-vars
  async verifyTransaction(_params) {
    return {
      verified: false,
      canVerify: false, // บอก paymentTransactions.js อย่างชัดเจนว่า "ตรวจสอบไม่ได้" ไม่ใช่ "ตรวจแล้วไม่ผ่าน"
      reason: "NO_PROVIDER_CONFIGURED"
    };
  }
}

export function getPaymentProvider() {
  // TODO: เมื่อมี payment provider จริง ให้ตรวจ process.env.PAYMENT_PROVIDER แล้ว return instance จริงแทน
  return new NullPaymentProvider();
}
