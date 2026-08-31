// scripts/setup-rich-menu.js
//
// สร้าง Rich Menu 1 อันตามภาพ assets/rich-menu/main-menu.jpg แล้วผูก action ให้ครบทุกปุ่ม
// จากนั้นตั้งเป็นเมนู default ของบอท (ให้ผู้ใช้ทุกคนเห็นเมนูนี้ทันทีโดยไม่ต้อง switchTo รายคน)
//
// วิธีรัน:
//   1. ตรวจสอบว่ามีไฟล์ .env ที่มี LINE_CHANNEL_ACCESS_TOKEN ตั้งไว้แล้ว (โหลดผ่าน dotenv หรือ export เอง)
//   2. node scripts/setup-rich-menu.js
//
// หมายเหตุ:
//   - ปุ่ม "สรุป" และ "หมวด/งบ" ใช้ action type "uri" ชี้ไปที่ /liff-redirect (ต้องตั้งค่า LIFF_ID ใน .env
//     ก่อน — ดูขั้นตอนสร้าง LIFF ใน README) เพื่อให้กดแล้วเปิดเว็บแดชบอร์ดของคนนั้นทันทีในคลิกเดียว
//     ไม่ต้องผ่านการ์งข้อความที่มีปุ่มให้กดซ้ำอีกที (เดิมทุกปุ่มเป็น "message" ส่งคำมาให้บอทตอบการ์ดก่อน)
//   - ปุ่ม "จดรายรับ/รายจ่าย", "วิเคราะห์", "รายการ", "ตั้งค่า", "แปลงร่างเป็น Pro", "ประกาศ", "Help" ยังใช้
//     action type "message" ส่งคำที่ตรงกับ handler ใน src/index.js (ตอบในแชททันที ไม่ต้องพึ่งเว็บ)
//   - ถ้าจะสร้าง Rich Menu แยกสำหรับ Premium (ภาพอื่น/ปุ่มอื่น) ให้รัน script นี้อีกรอบด้วยภาพอื่น
//     แล้วนำ richMenuId ที่ได้ไปใส่ .env เป็น LINE_RICH_MENU_FREE_ID / LINE_RICH_MENU_PREMIUM_ID
//     เพื่อให้ src/subscription/richMenu.js สลับเมนูตามแพ็กเกจได้ (ตอนนี้ script นี้สร้างแค่เมนูเดียว
//     แล้วตั้งเป็น default ให้ทุกคนเลย ถ้ายังไม่ต้องแยก Free/Premium ก็ใช้วิธีนี้พอ)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!TOKEN) {
  console.error("ไม่พบ LINE_CHANNEL_ACCESS_TOKEN — ตั้งค่าใน .env หรือ export ตัวแปรนี้ก่อนรัน");
  process.exit(1);
}
const BASE_URL = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
if (!BASE_URL) {
  console.error("ไม่พบ PUBLIC_BASE_URL — ตั้งค่าใน .env ก่อนรัน (ใช้สร้างลิงก์ /liff-redirect ของปุ่ม สรุป/หมวด-งบ)");
  process.exit(1);
}

// ไฟล์ต้นฉบับ assets/main-menu.jpg มีขนาด 1536x1024 ซึ่งไม่ตรงกับสเปกที่ LINE
// รองรับ (ต้องเป็น 2500x1686 หรือ 2500x843 เท่านั้น) จึงเตรียมไฟล์ที่ scale ให้ตรงสเปก
// ไว้ล่วงหน้าที่ assets/rich-menu/main-menu.jpg (สัดส่วนใกล้เคียงเดิม 1536:1024 ≈ 2500:1686
// จึงไม่บิดเพี้ยน และพิกัดปุ่มใน AREAS ด้านล่างคำนวณอิงกับขนาด 2500x1686 นี้อยู่แล้ว)
const IMAGE_PATH = path.join(__dirname, "..", "assets", "rich-menu", "main-menu.jpg");

// อัปโหลด/ดาวน์โหลดเนื้อหา (เช่น รูปภาพ rich menu) ต้องยิงไปที่ api-data.line.me
// endpoint อื่น ๆ ทั้งหมด (สร้าง/ลบ/ผูก rich menu) ยังใช้ api.line.me ตามปกติ
// อ้างอิง: https://developers.line.biz/en/reference/messaging-api/
async function callLineApi(endpoint, options, { useDataHost = false } = {}) {
  const host = useDataHost ? "https://api-data.line.me" : "https://api.line.me";
  const r = await fetch(`${host}${endpoint}`, {
    ...options,
    headers: { ...options?.headers, authorization: `Bearer ${TOKEN}` }
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`LINE API ${endpoint} -> ${r.status}: ${body}`);
  }
  return r;
}

// พิกัดคำนวณจากภาพต้นฉบับ (สแกนหาขอบปุ่มจริงจากสี background) แล้ว scale เป็น 2500x1686
// ลำดับปุ่มตามภาพ: การ์ดใหญ่จดรายรับ/รายจ่าย, สรุป, วิเคราะห์, หมวด/งบ, รายการ, แปลงร่างเป็น Pro, ประกาศ, ตั้งค่า, Help
const AREAS = [
  {
    // เดิมส่ง text: "กาแฟ 60" ซึ่งพอกดจะไปเด้งเป็นข้อความในช่องพิมพ์เฉย ๆ ให้ผู้ใช้กดส่งเอง (ไม่ได้จดอะไรจริง ทำให้เข้าใจผิด)
    // เปลี่ยนเป็นส่งคำสั่ง "จดรายการ" แทน — backend จะตอบสอนวิธีพิมพ์รายการทันที (ดู handler ใน src/index.js)
    bounds: { x: 0, y: 0, width: 1486, height: 963 },
    action: { type: "message", label: "จดรายรับ/รายจ่าย", text: "จดรายการ" }
  },
  {
    // เดิม type "message" ส่งคำ "สรุป" ให้บอทตอบเป็นการ์ดที่มีปุ่ม "เปิดแดชบอร์ด" ให้กดอีกที (2 คลิก)
    // เปลี่ยนเป็น type "uri" ชี้ /liff-redirect ตรง ๆ เพื่อเปิดเว็บทันทีในคลิกเดียว
    bounds: { x: 1486, y: 0, width: 483, height: 486 },
    action: { type: "uri", label: "สรุป", uri: `${BASE_URL}/liff-redirect` }
  },
  {
    bounds: { x: 1969, y: 0, width: 531, height: 486 },
    action: { type: "message", label: "วิเคราะห์", text: "วิเคราะห์" }
  },
  {
    // เดิม type "message" ส่งคำ "หมวด/งบ" ให้บอทตอบเป็นการ์ดที่มีปุ่มให้กดอีกที — เปลี่ยนเป็น uri เปิดตรง ๆ เช่นกัน
    bounds: { x: 1486, y: 486, width: 483, height: 477 },
    action: { type: "uri", label: "หมวด/งบ", uri: `${BASE_URL}/liff-redirect?page=budgets` }
  },
  {
    bounds: { x: 1969, y: 486, width: 531, height: 477 },
    action: { type: "message", label: "รายการ", text: "รายการ" }
  },
  {
    bounds: { x: 0, y: 963, width: 1006, height: 723 },
    action: { type: "message", label: "แปลงร่างเป็น Pro", text: "แปลงร่างเป็น Pro" }
  },
  {
    bounds: { x: 1006, y: 963, width: 480, height: 723 },
    action: { type: "message", label: "ประกาศ", text: "ประกาศ" }
  },
  {
    bounds: { x: 1486, y: 963, width: 483, height: 723 },
    action: { type: "message", label: "ตั้งค่า", text: "ตั้งค่า" }
  },
  {
    bounds: { x: 1969, y: 963, width: 531, height: 723 },
    action: { type: "message", label: "Help", text: "Help" }
  }
];

async function main() {
  if (!fs.existsSync(IMAGE_PATH)) {
    console.error(`ไม่พบไฟล์ภาพที่ ${IMAGE_PATH}`);
    process.exit(1);
  }

  console.log("1) สร้าง Rich Menu object...");
  const createRes = await callLineApi("/v2/bot/richmenu", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      size: { width: 2500, height: 1686 },
      selected: true,
      name: "ยายนวล - เมนูหลัก",
      chatBarText: "เมนู",
      areas: AREAS
    })
  });
  const { richMenuId } = await createRes.json();
  console.log("   richMenuId:", richMenuId);

  console.log("2) อัปโหลดรูปภาพ...");
  const imageBuffer = fs.readFileSync(IMAGE_PATH);
  await callLineApi(`/v2/bot/richmenu/${richMenuId}/content`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: imageBuffer
  }, { useDataHost: true });
  console.log("   อัปโหลดภาพสำเร็จ");

  console.log("3) ตั้งเป็นเมนู default ของบอท (ทุกคนเห็นทันที)...");
  await callLineApi(`/v2/bot/user/all/richmenu/${richMenuId}`, { method: "POST" });
  console.log("   ตั้งเป็น default แล้ว");

  console.log("\nเสร็จแล้ว! richMenuId =", richMenuId);
  console.log("ถ้าต้องการแยกเมนู Free/Premium ในอนาคต ให้เก็บ richMenuId นี้ไว้ และรัน script");
  console.log("อีกครั้งด้วยภาพอื่นสำหรับอีกแพ็กเกจ แล้วนำ id ทั้งสองไปใส่ .env ตามคอมเมนต์ด้านบนของไฟล์นี้");
}

main().catch((err) => {
  console.error("เกิดข้อผิดพลาด:", err.message);
  process.exit(1);
});


