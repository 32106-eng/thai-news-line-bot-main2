// สำคัญ (spec §6): OCR/Vision AI ในไฟล์นี้ใช้ "อ่านข้อมูล" จากสลิปเท่านั้น
// ผลลัพธ์จากไฟล์นี้ **ไม่ใช่หลักฐานการอนุมัติการจ่ายเงิน** — ห้ามนำ field ใด ๆ ที่คืนจากที่นี่
// ไปเปิด Premium โดยตรง ต้องผ่าน paymentProvider.js (real transaction check) หรือ PENDING_REVIEW เท่านั้น
// (ดู paymentTransactions.js ที่เรียกไฟล์นี้)

// เปลี่ยนมาใช้ NVIDIA NIM "nemotron-ocr-v2" (Image OCR NIM, /v1/ocr) แทนการเรียก chat.completions ด้วย VLM ทั่วไป
// ต่างจากเดิมโดยพื้นฐาน: nemotron-ocr-v2 คืน "ข้อความดิบ + ตำแหน่ง (bounding box)" เท่านั้น ไม่เข้าใจความหมาย
// (ไม่รู้ว่าอันไหนคือชื่อคน อันไหนคือชื่อธนาคาร อันไหนคือผู้โอน/ผู้รับ) — ต้องเขียน logic เดาโครงสร้างเอาเองด้านล่าง
// ความแม่นยำในการแยกผู้โอน/ผู้รับ/วันที่/เลขอ้างอิง จะต่ำกว่าตอนใช้ VLM เดิมที่เข้าใจ layout ได้เอง (รับทราบและยอมรับความเสี่ยงนี้แล้ว)

// endpoint นี้คนละตัวกับ chat completions ของ "ai" client (OpenAI SDK) จึงต้องเรียกด้วย fetch ตรง ๆ
// ตาม NVIDIA hosted API catalog: POST https://ai.api.nvidia.com/v1/ocr (build.nvidia.com hosted endpoint สำหรับ nemotron-ocr-v2)
const OCR_ENDPOINT = process.env.NVIDIA_OCR_ENDPOINT || "https://ai.api.nvidia.com/v1/ocr";

// ป้ายกำกับที่มักพบในสลิปธนาคาร/พร้อมเพย์ไทย ใช้แยก "ชื่อธนาคาร/วอลเล็ต/เลขบัญชี" ออกจาก "ชื่อคน/ชื่อร้าน"
const BANK_OR_ACCOUNT_HINTS = [
  "ธนาคาร", "ธ.", "บมจ.", "promptpay", "พร้อมเพย์", "wallet", "วอลเล็ต", "วอลเลท",
  "กสิกร", "ไทยพาณิชย์", "กรุงเทพ", "กรุงไทย", "กรุงศรี", "ทหารไทย", "ttb", "scb", "kbank", "bbl", "ktb", "bay",
  "truemoney", "ออมสิน", "อาคารสงเคราะห์", "ธ.ก.ส", "ธกส", "ชำระเงิน", "เลขที่บัญชี", "account", "a/c"
];
const NAME_TITLE_HINTS = ["นาย", "นาง", "น.ส.", "นางสาว", "ด.ช.", "ด.ญ.", "mr.", "mrs.", "ms."];
const AMOUNT_LABEL_HINTS = ["จำนวน", "จำนวนเงิน", "amount"];
const REF_LABEL_HINTS = ["เลขที่รายการ", "รหัสอ้างอิง", "ref", "หมายเลขอ้างอิง", "transaction id"];
const FEE_LABEL_HINTS = ["ค่าธรรมเนียม", "fee"]; // ตัดออก ไม่ให้ปนกับยอดโอนจริง

function norm(text) { return String(text ?? "").trim(); }
function lower(text) { return norm(text).toLowerCase(); }
function containsAny(text, hints) { const t = lower(text); return hints.some((h) => t.includes(h)); }

// ตัวเลขไทย/คอมมา/บาท ปนอยู่ในข้อความเดียวกันได้ (เช่น "100.00 บาท", "จำนวน: 1,234.50")
function extractAmountFromText(text) {
  const cleaned = norm(text).replace(/,/g, "");
  const match = cleaned.match(/(\d+(?:\.\d{1,2})?)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

// แปลง พ.ศ. -> ค.ศ. ถ้าปีที่เจอดูเป็นปีพุทธศักราช (>= 2500) หรือเป็นเลข 2 หลักท้ายปี (เช่น "69" = 2569 = 2026)
function convertBuddhistYear(year) {
  if (year >= 2500) return year - 543;
  if (year >= 0 && year < 100) return 2500 + year - 543; // เดา ค.ศ. ปัจจุบัน (เช่น 69 -> 2569 -> 2026)
  return year;
}
function tryParseThaiDate(text) {
  // รูปแบบที่พบบ่อย: "10 ก.ย. 69" "10/09/2569" "10-09-69  01:35" ฯลฯ — พยายามจับแบบหยาบ ๆ พอเป็น hint เท่านั้น
  const t = norm(text);
  const dmy = t.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const year = convertBuddhistYear(Number(y));
    const timeMatch = t.match(/(\d{1,2}):(\d{2})/);
    const hh = timeMatch ? Number(timeMatch[1]) : 0;
    const mm = timeMatch ? Number(timeMatch[2]) : 0;
    const date = new Date(Date.UTC(year, Number(m) - 1, Number(d), hh, mm));
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

// เรียก NIM OCR endpoint ดิบ ๆ คืน array ของ { text, y } เรียงจากบนลงล่างตามตำแหน่งแนวตั้งเฉลี่ยของกล่องข้อความ
async function extractRawText(mime, base64) {
  const res = await fetch(OCR_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(process.env.NVIDIA_API_KEY ? { authorization: `Bearer ${process.env.NVIDIA_API_KEY}` } : {})
    },
    body: JSON.stringify({
      input: [{ type: "image_url", url: `data:${mime};base64,${base64}` }],
      merge_levels: ["sentence"]
    })
  });
  if (!res.ok) {
    const err = new Error(`OCR NIM: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  const detections = json?.data?.[0]?.text_detections ?? [];
  return detections
    .map((d) => {
      const points = d.bounding_box?.points ?? [];
      const avgY = points.length ? points.reduce((sum, p) => sum + p.y, 0) / points.length : 0;
      return { text: norm(d.text_prediction?.text), y: avgY };
    })
    .filter((line) => line.text.length > 0)
    .sort((a, b) => a.y - b.y); // บนลงล่าง
}

// พยายามแยกชื่อคน/ร้านออกจากบล็อกข้อความต่อเนื่องกัน (ไม่รวมบรรทัดที่ดูเหมือนชื่อธนาคาร/เลขบัญชี/ป้ายกำกับอื่น)
function pickNameFromBlock(lines) {
  for (const line of lines) {
    if (containsAny(line, BANK_OR_ACCOUNT_HINTS)) continue;
    if (containsAny(line, AMOUNT_LABEL_HINTS) || containsAny(line, FEE_LABEL_HINTS) || containsAny(line, REF_LABEL_HINTS)) continue;
    if (/^\d[\d\s\-.]*$/.test(line)) continue; // บรรทัดที่เป็นตัวเลข/เลขบัญชีล้วน ๆ ไม่ใช่ชื่อ
    if (line.length < 2 || line.length > 60) continue;
    return line;
  }
  return null;
}

// คืนค่า { amount, transactionReference, paidAt, receiverName, senderName } หรือ null ถ้าอ่านไม่ได้เลย
// พารามิเตอร์ (ai, visionModel) ยังรับไว้เพื่อไม่ต้องแก้ call site อื่น แต่ไม่ได้ใช้แล้ว (endpoint นี้ไม่ผ่าน chat completions client)
export async function readSlip(_ai, _visionModel, mime, base64) {
  // ลองใหม่ได้ 1 ครั้งถ้าเจอ error 5xx/503 (service กำลังโหลด/คิวเต็มชั่วคราว) เหมือนพฤติกรรมเดิม
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const lines = await extractRawText(mime, base64);
      if (!lines.length) return null;

      const texts = lines.map((l) => l.text);
      const fullText = texts.join("\n");

      // ยอดเงิน: หาเลขที่อยู่ติดกับป้าย "จำนวน/จำนวนเงิน" ก่อน (ไม่เอาบรรทัด "ค่าธรรมเนียม") ถ้าไม่เจอค่อย fallback เป็นเลขที่มีทศนิยม 2 ตำแหน่งตัวแรกที่เจอ
      let amount = null;
      for (let i = 0; i < lines.length; i++) {
        if (containsAny(lines[i].text, FEE_LABEL_HINTS)) continue;
        if (containsAny(lines[i].text, AMOUNT_LABEL_HINTS)) {
          amount = extractAmountFromText(lines[i].text) ?? (lines[i + 1] ? extractAmountFromText(lines[i + 1].text) : null);
          if (amount) break;
        }
      }
      if (!amount) {
        const candidate = texts.find((t) => !containsAny(t, FEE_LABEL_HINTS) && /\d+\.\d{2}\b/.test(t));
        amount = candidate ? extractAmountFromText(candidate) : null;
      }

      // เลขที่รายการ/รหัสอ้างอิง
      let transactionReference = null;
      for (let i = 0; i < lines.length; i++) {
        if (containsAny(lines[i].text, REF_LABEL_HINTS)) {
          const sameLine = lines[i].text.replace(new RegExp(REF_LABEL_HINTS.join("|"), "i"), "").trim();
          transactionReference = sameLine.length > 3 ? sameLine : norm(lines[i + 1]?.text);
          break;
        }
      }

      // วันที่/เวลา: หาในบรรทัดแรก ๆ ที่ parse เป็นวันที่ได้ (มักอยู่บนสุดของสลิป)
      let paidAt = null;
      for (const t of texts) { const parsed = tryParseThaiDate(t); if (parsed) { paidAt = parsed; break; } }

      // ผู้โอน/ผู้รับ: สลิปไทยส่วนใหญ่แสดงบล็อกผู้โอนก่อน (ครึ่งบน) แล้วค่อยผู้รับ (ครึ่งล่าง) คั่นด้วยลูกศร/ไอคอน
      // ใช้ตำแหน่ง y กึ่งกลางแบ่งครึ่งบน/ล่างเป็นตัวเดาคร่าว ๆ (ไม่มีไอคอนลูกศรให้ตรวจจับตรง ๆ จาก OCR text ล้วน)
      const midY = 0.5;
      const topBlock = lines.filter((l) => l.y < midY).map((l) => l.text);
      const bottomBlock = lines.filter((l) => l.y >= midY).map((l) => l.text);
      const senderName = pickNameFromBlock(topBlock);
      const receiverName = pickNameFromBlock(bottomBlock);

      return {
        amount: Number.isFinite(amount) && amount > 0 && amount <= 10_000_000 ? amount : null,
        transactionReference: transactionReference ? transactionReference.slice(0, 120) : null,
        paidAt,
        receiverName: receiverName ? receiverName.slice(0, 120) : null,
        senderName: senderName ? senderName.slice(0, 120) : null,
        _rawOcrText: fullText.slice(0, 2000) // เก็บไว้ debug เท่านั้น ไม่ได้ผูกกับ logic อนุมัติใด ๆ
      };
    } catch (error) {
      const status = error?.status;
      const isRetryable = status === 503 || (typeof status === "number" && status >= 500);
      console.warn(`Slip OCR read failed (attempt ${attempt + 1}/2, status=${status ?? "n/a"}):`, error.message);
      if (attempt === 0 && isRetryable) continue;
      return null;
    }
  }
}
