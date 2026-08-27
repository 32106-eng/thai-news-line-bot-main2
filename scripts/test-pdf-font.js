// รันสคริปต์นี้ครั้งเดียวหลังวางไฟล์ฟอนต์ (fonts/NotoSansThai-Regular.ttf, fonts/NotoSansThai-Bold.ttf)
// เพื่อสร้าง PDF ทดสอบเปิดดูว่าตัวอักษรไทยขึ้นถูกต้องจริงก่อนเปิดใช้งานฟีเจอร์ export จริงบนเว็บ
//
// วิธีใช้:
//   node scripts/test-pdf-font.js
// แล้วเปิดไฟล์ test-output/font-test.pdf ดูด้วยตา — ถ้าเห็นข้อความไทยอ่านออกปกติ (ไม่ใช่กล่องเปล่า/สี่เหลี่ยมทึบ) แปลว่าฟอนต์พร้อมใช้งาน
//
// ควรรันสคริปต์นี้ทั้งก่อน deploy (เครื่อง dev) และหลัง deploy จริงบน Render อย่างน้อยครั้งแรก เพราะ font rendering
// อาจต่างกันได้ถ้า environment ขาด library บางตัว (เช่น fontconfig) แม้โค้ดจะรันผ่านไม่ error ก็ตาม
import fs from "node:fs";
import path from "node:path";
import { generateReportPdf } from "../src/reports/pdfReport.js";

const sampleTransactions = [
  { createdAt: new Date().toISOString(), type: "expense", description: "กาแฟและขนมปังเช้า", category: "อาหาร", amount: 65 },
  { createdAt: new Date().toISOString(), type: "expense", description: "ค่ารถไฟฟ้า BTS ไปทำงาน", category: "เดินทาง", amount: 44 },
  { createdAt: new Date().toISOString(), type: "expense", description: "ค่าไฟฟ้าประจำเดือน", category: "บิล", amount: 890 },
  { createdAt: new Date().toISOString(), type: "expense", description: "ทำบุญวันเกิดคุณแม่", category: "ทำบุญ", amount: 500 }, // ทดสอบหมวดที่ AI ตั้งขึ้นเองด้วย (ไม่ใช่ 6 หมวดคงที่)
  { createdAt: new Date().toISOString(), type: "income", description: "เงินเดือนประจำเดือน", category: "รายรับ", amount: 25000 }
];

const output = await generateReportPdf({
  period: "month",
  year: new Date().getFullYear(),
  month: new Date().getMonth() + 1,
  transactions: sampleTransactions,
  budgets: { "อาหาร": 3000, "เดินทาง": 1500 },
  ownerLabel: "ทดสอบฟอนต์ — ยายจันทร์ ใจดี"
});

const outDir = path.join(process.cwd(), "test-output");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "font-test.pdf");
fs.writeFileSync(outPath, output);
console.log(`สร้างไฟล์ทดสอบแล้วที่: ${outPath}`);
console.log("เปิดไฟล์นี้ดูด้วยตา — ถ้าตัวอักษรไทยอ่านออกปกติ (ไม่ใช่กล่องเปล่า) แปลว่าฟอนต์พร้อมใช้งานจริง");
