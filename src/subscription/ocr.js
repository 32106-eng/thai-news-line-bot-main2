// สำคัญ (spec §6): OCR/Vision AI ในไฟล์นี้ใช้ "อ่านข้อมูล" จากสลิปเท่านั้น
// ผลลัพธ์จากไฟล์นี้ **ไม่ใช่หลักฐานการอนุมัติการจ่ายเงิน** — ห้ามนำ field ใด ๆ ที่คืนจากที่นี่
// ไปเปิด Premium โดยตรง ต้องผ่าน paymentProvider.js (real transaction check) หรือ PENDING_REVIEW เท่านั้น
// (ดู paymentTransactions.js ที่เรียกไฟล์นี้)

export async function readSlip(ai, visionModel, mime, base64) {
  if (!ai || !visionModel) return null;
  try {
    const completion = await ai.chat.completions.create({
      model: visionModel,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You read Thai bank/PromptPay payment slip photos. Reply only JSON with these fields: " +
            '{"amount": number, "transactionReference": string|null, "paidAt": string|null, "receiverName": string|null, "senderName": string|null}. ' +
            "amount is the total paid in THB as a plain number (no currency symbol/commas). " +
            "transactionReference is any transaction/reference ID printed on the slip (e.g. after \"เลขที่รายการ\" or \"Ref\"), or null if not visible. " +
            "paidAt is an ISO 8601 datetime if a date/time is printed on the slip, else null. " +
            "This data will be used only as a hint for manual review — never state or imply the payment is verified."
        },
        {
          role: "user",
          content: [
            { type: "text", text: "อ่านข้อมูลจากสลิปการโอนเงินนี้" },
            { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } }
          ]
        }
      ]
    });
    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}");
    const amount = Number(parsed.amount);
    return {
      amount: Number.isFinite(amount) && amount > 0 && amount <= 10_000_000 ? amount : null,
      transactionReference: parsed.transactionReference ? String(parsed.transactionReference).trim().slice(0, 120) : null,
      paidAt: parsed.paidAt && !Number.isNaN(new Date(parsed.paidAt).getTime()) ? new Date(parsed.paidAt).toISOString() : null,
      receiverName: parsed.receiverName ? String(parsed.receiverName).trim().slice(0, 120) : null,
      senderName: parsed.senderName ? String(parsed.senderName).trim().slice(0, 120) : null
    };
  } catch (error) {
    console.warn("Slip OCR read failed:", error.message);
    return null;
  }
}
