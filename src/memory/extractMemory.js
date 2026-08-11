// ดึง "ชื่อ" หรือ "ข้อมูลส่วนตัวที่ควรจำ" จากข้อความสนทนาแบบเบา ๆ ด้วย AI
// เรียกเฉพาะตอนข้อความไม่ใช่การจดรายการบัญชี (parse() คืน null) เพื่อไม่ให้ทุกข้อความ "กาแฟ 60" ยิง AI เพิ่มโดยไม่จำเป็น
// ถ้าไม่มีอะไรน่าจำ ให้คืนค่าว่างเงียบ ๆ ไม่กระทบ flow การตอบเดิม และห้าม throw ออกไปนอกฟังก์ชันนี้เด็ดขาด

export async function extractMemoryFromText(ai, model, text) {
  if (!ai || !model) return { name: null, facts: [] };
  try {
    const completion = await ai.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 200,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "อ่านข้อความภาษาไทยนี้ แล้วดึงเฉพาะข้อมูลส่วนตัวที่ผู้พูดเปิดเผยเกี่ยวกับ \"ตัวเอง\" เท่านั้น (ไม่ใช่คนอื่นที่พูดถึง) เช่น ชื่อ, อาชีพ, สิ่งที่ชอบ/ไม่ชอบ, เป้าหมาย, ข้อมูลครอบครัว ที่ควรจำไว้ใช้ในการคุยครั้งต่อไป\n" +
            "ถ้าไม่มีข้อมูลแบบนี้เลย ให้ตอบ {\"name\":null,\"facts\":[]}\n" +
            "ถ้าข้อความบอกชื่อของผู้พูดเอง (เช่น \"ฉันชื่อกอล์ฟ\", \"เรียกฉันว่าแนน\") ให้ใส่ใน name\n" +
            "facts เป็น array ของสตริงสั้น ๆ ไม่เกิน 3 อัน แต่ละอันไม่เกิน 100 ตัวอักษร ตอบ JSON เท่านั้น รูปแบบ: {\"name\": string|null, \"facts\": string[]}"
        },
        { role: "user", content: text }
      ]
    });
    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}");
    const name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : null;
    const facts = Array.isArray(parsed.facts) ? parsed.facts.filter((f) => typeof f === "string" && f.trim()).slice(0, 3) : [];
    return { name, facts };
  } catch (error) {
    console.warn("AI memory extraction skipped:", error.message);
    return { name: null, facts: [] };
  }
}
