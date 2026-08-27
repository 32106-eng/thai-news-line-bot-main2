// สำคัญ (spec §6): OCR/Vision AI ในไฟล์นี้ใช้ "อ่านข้อมูล" จากสลิปเท่านั้น
// ผลลัพธ์จากไฟล์นี้ **ไม่ใช่หลักฐานการอนุมัติการจ่ายเงิน** — ห้ามนำ field ใด ๆ ที่คืนจากที่นี่
// ไปเปิด Premium โดยตรง ต้องผ่าน paymentProvider.js (real transaction check) หรือ PENDING_REVIEW เท่านั้น
// (ดู paymentTransactions.js ที่เรียกไฟล์นี้)

export async function readSlip(ai, visionModel, mime, base64) {
  if (!ai || !visionModel) return null;
  // ลองใหม่ได้ 1 ครั้งถ้าเจอ error 5xx (เช่น "EngineCore encountered an issue" จาก NVIDIA NIM) เพราะมักเป็นปัญหาชั่วคราวฝั่ง provider
  // ไม่ใช่ปัญหาภาพหรือโค้ดเรา — ถ้าลองใหม่แล้วยังพังอีก ถึงจะคืน null (โมเดล/provider พังจริง ไม่ใช่รูปไม่ชัด) — เหมือน readReceipt() ใน index.js
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const completion = await ai.chat.completions.create({
        model: visionModel,
        temperature: 0,
        max_tokens: 200, // เอาต์พุตเป็น JSON เล็ก ๆ (amount/transactionReference/paidAt/receiverName/senderName) ไม่ควรยาวเกินนี้
        // ไม่ใส่ response_format: json_object เพราะบางโมเดล (เช่น NVIDIA NIM VLM บางตัว หรือโมเดลที่ตอบเป็นข้อความอธิบายนำก่อน)
        // จะตอบ 500 หรือใส่ prose ภาษาไทยนำหน้า JSON (เช่น "ข้อมูลที่อ่านได้...") ทั้งที่ถูกบังคับ structured output แล้ว
        // ทำให้ JSON.parse พังด้วย "Unexpected token" — คุม JSON ผ่าน prompt + cleanup ก่อน parse แทน (เหมือน readReceipt() ใน index.js)
        messages: [
          {
            role: "system",
            content:
              "You read Thai bank/PromptPay payment slip photos. Reply with ONLY a raw JSON object, no markdown code fences, no explanation before or after, in this exact shape: " +
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
      const raw = completion.choices[0]?.message?.content ?? "{}";
      // บางโมเดลยังห่อคำตอบด้วย ```json ... ``` หรือพูดนำก่อน/หลัง JSON ทั้งที่สั่งห้ามแล้ว — ตัด markdown fence ออกก่อน
      // แล้วดึงเฉพาะช่วง { ... } แรกที่เจอ กันกรณีมีประโยคอธิบายนำหน้า (เช่น "ข้อมูลที่อ่านได้จากสลิปนี้คือ {...}")
      let cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      const braceStart = cleaned.indexOf("{");
      const braceEnd = cleaned.lastIndexOf("}");
      if (braceStart !== -1 && braceEnd !== -1 && braceEnd > braceStart) cleaned = cleaned.slice(braceStart, braceEnd + 1);
      const parsed = JSON.parse(cleaned || "{}");
      const amount = Number(parsed.amount);
      return {
        amount: Number.isFinite(amount) && amount > 0 && amount <= 10_000_000 ? amount : null,
        transactionReference: parsed.transactionReference ? String(parsed.transactionReference).trim().slice(0, 120) : null,
        paidAt: parsed.paidAt && !Number.isNaN(new Date(parsed.paidAt).getTime()) ? new Date(parsed.paidAt).toISOString() : null,
        receiverName: parsed.receiverName ? String(parsed.receiverName).trim().slice(0, 120) : null,
        senderName: parsed.senderName ? String(parsed.senderName).trim().slice(0, 120) : null
      };
    } catch (error) {
      const status = error?.status ?? error?.response?.status;
      const isServerError = typeof status === "number" && status >= 500;
      console.warn(`Slip OCR read failed (attempt ${attempt + 1}/2, status=${status ?? "n/a"}):`, error.message);
      if (attempt === 0 && isServerError) continue; // ลองใหม่อีกครั้งเฉพาะ error 5xx (ฝั่ง provider พัง) ไม่ retry error อื่น เช่น JSON parse ผิดปกติซ้ำ ๆ
      return null;
    }
  }
}
