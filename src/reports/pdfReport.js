// สร้างรายงาน PDF สรุปรายเดือน/รายปี (ฟีเจอร์ Premium) — ใช้ pdfkit สร้าง PDF ตรง ๆ ฝั่งเซิร์ฟเวอร์
//
// ⚠️ ต้องมีฟอนต์ไทยวางไว้ก่อนถึงจะใช้งานได้จริง — ฟอนต์ built-in ของ pdfkit (Helvetica ฯลฯ) ไม่มีตัวอักษรไทยเลย
// ถ้าไม่ใส่ฟอนต์แยก ข้อความไทยในรายงานจะกลายเป็นกล่องเปล่า/สี่เหลี่ยมทึบทั้งหมด (glyph not found)
// วิธีติดตั้ง (ทำครั้งเดียว):
//   1. ดาวน์โหลด Noto Sans Thai จาก Google Fonts: https://fonts.google.com/noto/specimen/Noto+Sans+Thai
//   2. วางไฟล์ที่ fonts/NotoSansThai-Regular.ttf และ fonts/NotoSansThai-Bold.ttf (ต้องชื่อไฟล์ตรงนี้เป๊ะ ๆ)
//   3. รัน `node scripts/test-pdf-font.js` (ดูไฟล์นี้ในโปรเจกต์) เพื่อสร้าง PDF ทดสอบ เปิดดูว่าตัวอักษรไทยขึ้นถูกต้องก่อน deploy จริง
//      โดยเฉพาะบน Render ที่ environment อาจต่างจากเครื่อง dev ควรทดสอบซ้ำหลัง deploy อย่างน้อยครั้งแรก
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_REGULAR = path.join(__dirname, "..", "..", "fonts", "NotoSansThai-Regular.ttf");
const FONT_BOLD = path.join(__dirname, "..", "..", "fonts", "NotoSansThai-Bold.ttf");

// เช็คตอน import ว่ามีไฟล์ฟอนต์จริงไหม — ถ้าไม่มี ให้ throw ตอนเรียกใช้งานจริงแทนที่จะสร้าง PDF ที่ตัวอักษรไทยพังเงียบ ๆ
// (ดีกว่าให้ผู้ใช้ได้ PDF ที่มีแต่กล่องเปล่าโดยไม่รู้สาเหตุ)
function assertFontsReady() {
  const missing = [FONT_REGULAR, FONT_BOLD].filter((p) => !fs.existsSync(p));
  if (missing.length) {
    throw new Error(`ไม่พบไฟล์ฟอนต์ไทยสำหรับสร้าง PDF: ${missing.map((p) => path.relative(process.cwd(), p)).join(", ")} — ดูวิธีติดตั้งที่คอมเมนต์ต้นไฟล์ src/reports/pdfReport.js`);
  }
}

const PINK = "#D23283";
const INK = "#2B2320";
const INK_SOFT = "#9B94A0";
const CREAM = "#FBF3EC";
const LINE_COLOR = "#EFE3D8";

function money(value) { return new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2 }).format(value); }
function thaiMonthYear(year, month) {
  const thaiMonths = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
  return `${thaiMonths[month - 1]} ${year + 543}`; // ปี พ.ศ.
}

// วาดแถบความคืบหน้างบประมาณ (เหมือน budget-bar ใน dashboard.html แต่วาดด้วย pdfkit vector ตรง ๆ)
function drawProgressBar(doc, x, y, width, height, ratio, overBudget) {
  doc.roundedRect(x, y, width, height, height / 2).fill(LINE_COLOR);
  const filled = Math.max(Math.min(ratio, 1), 0) * width;
  if (filled > 0) doc.roundedRect(x, y, Math.max(filled, height), height, height / 2).fill(overBudget ? "#B0225F" : PINK);
}

// วาดกราฟแท่งแนวนอนสำหรับสรุปหมวดหมู่ที่ใช้จ่ายมากสุด (แทนกราฟวงกลม — วาดง่ายกว่าด้วย pdfkit primitives ล้วน ไม่ต้องพึ่ง chart library เพิ่ม)
function drawCategoryBars(doc, categories, startY, width) {
  const maxAmount = Math.max(...categories.map(([, amount]) => amount), 1);
  let y = startY;
  const barHeight = 10, rowGap = 26, labelWidth = 110;
  for (const [category, amount] of categories) {
    doc.font("Thai").fontSize(10).fillColor(INK).text(category, doc.page.margins.left, y, { width: labelWidth - 8, height: 14, ellipsis: true });
    const barX = doc.page.margins.left + labelWidth;
    const barMaxWidth = width - labelWidth - 70;
    doc.roundedRect(barX, y + 1, barMaxWidth, barHeight, barHeight / 2).fill(LINE_COLOR);
    const filled = (amount / maxAmount) * barMaxWidth;
    if (filled > 0) doc.roundedRect(barX, y + 1, Math.max(filled, barHeight), barHeight, barHeight / 2).fill(PINK);
    doc.font("Thai").fontSize(9).fillColor(INK_SOFT).text(money(amount), barX + barMaxWidth + 8, y, { width: 60 });
    y += rowGap;
  }
  return y;
}

/**
 * สร้างรายงาน PDF สรุปธุรกรรม ส่งกลับเป็น Buffer (ให้ endpoint ฝั่ง index.js ส่งต่อเป็น response ได้เลย)
 * @param {object} params
 * @param {"month"|"year"} params.period - ช่วงเวลาของรายงาน
 * @param {number} params.year
 * @param {number} [params.month] - จำเป็นถ้า period==="month" (1-12)
 * @param {Array} params.transactions - รายการทั้งหมดในช่วงเวลานั้น (กรองมาก่อนแล้วจาก caller)
 * @param {Record<string, number>} params.budgets - งบประมาณต่อหมวด (เฉพาะ period==="month")
 * @param {string} params.ownerLabel - ชื่อ/ป้ายกำกับเจ้าของรายงาน (ชื่อผู้ใช้ หรือชื่อกลุ่ม) แสดงหน้าปก
 */
export async function generateReportPdf({ period, year, month, transactions, budgets = {}, ownerLabel }) {
  assertFontsReady();
  // import แบบ dynamic เพราะ pdfkit เป็น dependency ใหม่ที่เพิ่งเพิ่ม — ถ้ายังไม่ได้ npm install จะได้ error ชัดเจนตอนเรียกใช้งานจริง
  // แทนที่จะทำให้ทั้งแอปพังตั้งแต่ import ตอน server start (endpoint อื่นที่ไม่เกี่ยวจะยังทำงานได้ปกติ)
  const { default: PDFDocument } = await import("pdfkit");
  const doc = new PDFDocument({ size: "A4", margin: 48, bufferPages: true });
  doc.registerFont("Thai", FONT_REGULAR);
  doc.registerFont("Thai-Bold", FONT_BOLD);

  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const income = transactions.filter((t) => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const expense = transactions.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  const net = income - expense;
  const byCategory = Object.entries(
    transactions.filter((t) => t.type === "expense").reduce((acc, t) => ({ ...acc, [t.category]: (acc[t.category] ?? 0) + t.amount }), {})
  ).sort((a, b) => b[1] - a[1]);

  // ---- หน้าปก / สรุปภาพรวม ----
  doc.rect(0, 0, doc.page.width, 130).fill(CREAM);
  doc.font("Thai-Bold").fontSize(20).fillColor(INK).text("ยายจันทร์", doc.page.margins.left, 40);
  doc.font("Thai").fontSize(11).fillColor(INK_SOFT).text("รายงานสรุปการเงิน", doc.page.margins.left, 66);
  const periodLabel = period === "year" ? `ปี ${year + 543}` : thaiMonthYear(year, month);
  doc.font("Thai-Bold").fontSize(16).fillColor(PINK).text(periodLabel, doc.page.margins.left, 88);
  if (ownerLabel) doc.font("Thai").fontSize(10).fillColor(INK_SOFT).text(String(ownerLabel).slice(0, 60), doc.page.margins.left, 110);

  let y = 160;
  const colWidth = pageWidth / 3;
  const summaryCards = [
    { label: "รายรับรวม", value: money(income), color: "#2E8B57" },
    { label: "รายจ่ายรวม", value: money(expense), color: PINK },
    { label: net >= 0 ? "คงเหลือ" : "ติดลบ", value: money(Math.abs(net)), color: net >= 0 ? INK : "#B0225F" }
  ];
  summaryCards.forEach((card, i) => {
    const x = doc.page.margins.left + i * colWidth;
    doc.font("Thai").fontSize(9).fillColor(INK_SOFT).text(card.label, x, y);
    doc.font("Thai-Bold").fontSize(15).fillColor(card.color).text(`${card.value} บาท`, x, y + 14, { width: colWidth - 10 });
  });
  y += 60;
  doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).strokeColor(LINE_COLOR).lineWidth(1).stroke();
  y += 24;

  // ---- หมวดหมู่ที่ใช้จ่ายมากที่สุด ----
  if (byCategory.length) {
    doc.font("Thai-Bold").fontSize(13).fillColor(INK).text("หมวดที่ใช้จ่ายมากที่สุด", doc.page.margins.left, y);
    y += 24;
    y = drawCategoryBars(doc, byCategory.slice(0, 8), y, pageWidth);
    y += 16;
  }

  // ---- งบประมาณ vs ใช้จริง (เฉพาะรายงานรายเดือน เพราะงบตั้งเป็นรายเดือนในระบบนี้) ----
  const budgetEntries = Object.entries(budgets).filter(([, limit]) => limit > 0);
  if (period === "month" && budgetEntries.length) {
    if (y > doc.page.height - 200) { doc.addPage(); y = doc.page.margins.top; }
    doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).strokeColor(LINE_COLOR).lineWidth(1).stroke();
    y += 20;
    doc.font("Thai-Bold").fontSize(13).fillColor(INK).text("งบประมาณเทียบกับการใช้จริง", doc.page.margins.left, y);
    y += 24;
    for (const [category, limit] of budgetEntries) {
      const spent = transactions.filter((t) => t.type === "expense" && t.category === category).reduce((s, t) => s + t.amount, 0);
      const over = spent > limit;
      doc.font("Thai").fontSize(10).fillColor(INK).text(`${category}`, doc.page.margins.left, y);
      doc.font("Thai").fontSize(9).fillColor(over ? "#B0225F" : INK_SOFT).text(`${money(spent)} / ${money(limit)} บาท`, doc.page.margins.left, y, { width: pageWidth, align: "right" });
      y += 14;
      drawProgressBar(doc, doc.page.margins.left, y, pageWidth, 8, spent / limit, over);
      y += 22;
      if (y > doc.page.height - 100) { doc.addPage(); y = doc.page.margins.top; }
    }
    y += 10;
  }

  // ---- ตารางรายการทั้งหมด ----
  if (y > doc.page.height - 150) { doc.addPage(); y = doc.page.margins.top; }
  doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).strokeColor(LINE_COLOR).lineWidth(1).stroke();
  y += 20;
  doc.font("Thai-Bold").fontSize(13).fillColor(INK).text(`รายการทั้งหมด (${transactions.length} รายการ)`, doc.page.margins.left, y);
  y += 22;

  const colDate = doc.page.margins.left, colDesc = colDate + 70, colCat = colDesc + 160, colAmount = colCat + 100;
  const drawTableHeader = () => {
    doc.font("Thai-Bold").fontSize(9).fillColor(INK_SOFT);
    doc.text("วันที่", colDate, y, { width: 65 });
    doc.text("รายการ", colDesc, y, { width: 155 });
    doc.text("หมวดหมู่", colCat, y, { width: 95 });
    doc.text("จำนวนเงิน", colAmount, y, { width: 90, align: "right" });
    y += 16;
    doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).strokeColor(LINE_COLOR).lineWidth(0.5).stroke();
    y += 8;
  };
  drawTableHeader();
  const sorted = [...transactions].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  for (const tx of sorted) {
    if (y > doc.page.height - 60) { doc.addPage(); y = doc.page.margins.top; drawTableHeader(); }
    const dateLabel = new Date(tx.createdAt).toLocaleDateString("th-TH", { day: "2-digit", month: "2-digit", timeZone: "Asia/Bangkok" });
    doc.font("Thai").fontSize(9).fillColor(INK);
    doc.text(dateLabel, colDate, y, { width: 65 });
    doc.text(String(tx.description ?? "").slice(0, 40), colDesc, y, { width: 155, ellipsis: true });
    doc.text(tx.category, colCat, y, { width: 95, ellipsis: true });
    doc.fillColor(tx.type === "income" ? "#2E8B57" : INK).text(`${tx.type === "income" ? "+" : "-"}${money(tx.amount)}`, colAmount, y, { width: 90, align: "right" });
    y += 16;
  }

  // ---- เลขหน้า (ใส่ท้ายสุดหลังรู้จำนวนหน้าทั้งหมดแล้ว — bufferPages: true ทำให้ย้อนกลับไปวาดหน้าเก่าได้) ----
  const pageCount = doc.bufferedPageRange().count;
  for (let i = 0; i < pageCount; i++) {
    doc.switchToPage(i);
    doc.font("Thai").fontSize(8).fillColor(INK_SOFT).text(`หน้า ${i + 1} จาก ${pageCount}`, doc.page.margins.left, doc.page.height - 32, { width: pageWidth, align: "center" });
  }

  doc.end();
  return done;
}


