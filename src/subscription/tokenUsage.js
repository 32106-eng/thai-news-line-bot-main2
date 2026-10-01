// บันทึก/สรุปการใช้โทเค็นของ AI (chat.completions) แยกตามคน — ใช้ดูในเว็บแอดมิน (/admin) และคำสั่งแชท "แอดมิน"
// (ดู index.js: enrichWithAi/askFinanceAi, ocr.js: readSlip, admin/routes.js: /api/token-usage)
// เป็นแค่สถิติการใช้งาน ไม่ใช่ business logic ใด ๆ — record() ต้องไม่มีวันทำให้ flow หลัก (จดบัญชี/อ่านสลิป/ถามตอบ) พังหรือช้าลง
// เหมือน auditLog.js: catch เงียบ ๆ เอง ไม่ throw ออกไปกระทบ caller และเรียกแบบ fire-and-forget (ไม่ await) ที่ call site เสมอ

export function createTokenUsageService({ tokenUsage, FieldValue }) {
  /**
   * บันทึกการใช้โทเค็น 1 ครั้งของ AI call
   * usage คือ object รูปแบบ OpenAI SDK ตรง ๆ ({ prompt_tokens, completion_tokens, total_tokens })
   * ใช้ได้กับทุก provider ที่ project นี้รองรับ (OpenAI/NVIDIA NIM/OpenRouter) เพราะทุกตัวคืน usage รูปแบบเดียวกัน (OpenAI-compatible)
   */
  async function record({ userId, feature, model, usage }) {
    if (!userId || !usage) return;
    try {
      const promptTokens = Number(usage.prompt_tokens) || 0;
      const completionTokens = Number(usage.completion_tokens) || 0;
      const totalTokens = Number(usage.total_tokens) || promptTokens + completionTokens;
      if (totalTokens <= 0) return;
      await tokenUsage.add({
        userId: String(userId),
        feature: feature ?? null, // "enrich" | "ask" | "slip_ocr" — เผื่อไว้ดูย้อนหลังว่าโทเค็นไปกับฟีเจอร์ไหนเยอะสุด
        model: model ?? null,
        promptTokens,
        completionTokens,
        totalTokens,
        createdAt: FieldValue.serverTimestamp()
      });
    } catch (error) {
      console.warn("Token usage log failed:", error.message);
    }
  }

  /** รวมโทเค็นทั้งหมดตั้งแต่ since ถึงตอนนี้ แยกตามคน เรียงจากใช้เยอะสุดไปน้อยสุด */
  async function summarizeSince(since) {
    const snap = await tokenUsage.where("createdAt", ">=", since).get();
    const byUser = new Map();
    let total = 0;
    for (const doc of snap.docs) {
      const data = doc.data();
      const uid = data.userId;
      if (!uid) continue;
      const t = Number(data.totalTokens) || 0;
      byUser.set(uid, (byUser.get(uid) ?? 0) + t);
      total += t;
    }
    const rows = [...byUser.entries()]
      .map(([userId, tokens]) => ({ userId, tokens }))
      .sort((a, b) => b.tokens - a.tokens);
    return { rows, total };
  }

  return { record, summarizeSince };
}
