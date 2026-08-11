// ความจำของ "คนจริง" (LINE userId) แยกขาดจาก panuan_users ที่เก็บธุรกรรม
// เหตุผลที่แยก: ในกลุ่ม บัญชี/กองกลางถูกคีย์ด้วย groupId (ใช้ร่วมกันทั้งกลุ่ม)
// แต่ "ความจำ" ต้องเป็นของแต่ละคนเสมอ ไม่ปนกับคนอื่นในกลุ่มเดียวกัน
// จึงคีย์ด้วย personId = event.source.userId เท่านั้น (เหมือนกันทั้งใน 1:1 และในกลุ่ม)
//
// ความปลอดภัย: โค้ดเป็นคนตัดสินใจเองว่าจะดึงความจำของใครมาใส่ context (ตาม personId ที่รู้จาก LINE event)
// ไม่ได้ให้ AI เป็นคนเลือกว่าจะเปิดเผยความจำของใคร จึงไม่มีช่องให้ความจำของคนหนึ่งรั่วไปให้อีกคนเห็นในกลุ่มเดียวกัน

const MAX_FACTS = 40; // กันข้อมูลบวมไม่รู้จบ ตัวเก่าสุดหลุดออกเมื่อเต็ม (FIFO)

export function createMemoryService({ memories, FieldValue }) {
  async function getMemory(personId) {
    const snap = await memories.doc(String(personId)).get();
    return snap.exists ? { name: null, facts: [], ...snap.data() } : { name: null, facts: [] };
  }

  async function setName(personId, name) {
    if (!name || typeof name !== "string") return;
    await memories.doc(String(personId)).set({ name: name.trim().slice(0, 60), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }

  /** เพิ่ม fact หนึ่งอัน (ทั้งจากคำสั่ง "จำไว้ว่า" และจากการดึงอัตโนมัติของ AI) */
  async function addFact(personId, text, source = "auto") {
    const trimmed = (text ?? "").trim().slice(0, 200);
    if (!trimmed) return;
    const current = await getMemory(personId);
    const fact = { id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, text: trimmed, source, createdAt: new Date().toISOString() };
    const facts = [...current.facts, fact].slice(-MAX_FACTS); // เก็บแค่ MAX_FACTS อันล่าสุด ตัวเก่าสุดหลุดออกก่อน
    await memories.doc(String(personId)).set({ facts, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }

  async function clearAll(personId) {
    await memories.doc(String(personId)).set({ name: null, facts: [], updatedAt: FieldValue.serverTimestamp() });
  }

  /** ใช้ต่อ context ให้ askFinanceAi เรียกชื่อถูกและอ้างอิงสิ่งที่เคยจำไว้ได้ ไม่มีอะไรจำไว้ก็คืนค่าว่าง */
  function buildContextLine({ name, facts }) {
    if (!name && facts.length === 0) return "";
    const parts = [];
    if (name) parts.push(`ชื่อ: ${name}`);
    if (facts.length) parts.push(`สิ่งที่เคยจำไว้: ${facts.map((f) => f.text).join("; ")}`);
    return `\n\nข้อมูลที่เคยจำไว้เกี่ยวกับผู้ใช้คนนี้โดยเฉพาะ (ห้ามนำไปใช้กับคนอื่น แม้จะอยู่กลุ่มเดียวกัน):\n${parts.join("\n")}`;
  }

  return { getMemory, setName, addFact, clearAll, buildContextLine, MAX_FACTS };
}
