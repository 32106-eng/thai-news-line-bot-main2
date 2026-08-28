import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import QRCode from "qrcode";
import OpenAI from "openai";
import sharp from "sharp";
import cron from "node-cron";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

import { buildSubscriptionCollections } from "./subscription/db.js";
import { createAuditLogger } from "./subscription/auditLog.js";
import { createSubscriptionService, PLAN } from "./subscription/subscriptions.js";
import { createPaymentSessionService } from "./subscription/paymentSessions.js";
import { createUploadSessionService } from "./subscription/uploadSessions.js";
import { createPaymentTransactionService, TX_STATUS } from "./subscription/paymentTransactions.js";
import { getPaymentProvider } from "./subscription/paymentProvider.js";
import { createQrService } from "./subscription/qr.js";
import { generateReportPdf } from "./reports/pdfReport.js";
import { readSlip } from "./subscription/ocr.js";
import { createRichMenuService } from "./subscription/richMenu.js";
import { createSubscriptionLineHandlers } from "./subscription/lineHandlers.js";
import { createGroupLinkService, CONFIRM_WINDOW_MINUTES } from "./subscription/groupLinks.js";
import { createAdminAuth } from "./admin/auth.js";
import { createAdminRouter } from "./admin/routes.js";

for (const name of ["LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN", "FIREBASE_SERVICE_ACCOUNT", "ADMIN_SESSION_SECRET"]) {
  if (!process.env[name]) throw new Error(`Missing ${name}. Add it to .env.`);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// data now lives in Firestore instead of a local file, so it survives every redeploy
const firebaseApp = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const usersCol = getFirestore(firebaseApp).collection("panuan_users");
const aiKey = process.env.OPENAI_API_KEY ?? process.env.NVIDIA_API_KEY ?? process.env.OPENROUTER_API_KEY;
const aiBaseURL = process.env.OPENAI_API_KEY
  ? undefined
  : process.env.NVIDIA_API_KEY
    ? "https://integrate.api.nvidia.com/v1"
    : process.env.OPENROUTER_API_KEY
      ? "https://openrouter.ai/api/v1"
      : undefined;
// ลำดับความสำคัญ: OPENAI_API_KEY > NVIDIA_API_KEY > OPENROUTER_API_KEY — ตั้งค่าคีย์ตัวไหนไว้
// ระบบจะใช้ตัวนั้นเป็นหลักโดยอัตโนมัติ (ไม่ต้องลบคีย์ตัวเก่าออกก็ได้ แค่ตัวที่ priority สูงกว่าจะชนะ)
const ai = aiKey ? new OpenAI({ apiKey: aiKey, ...(aiBaseURL ? { baseURL: aiBaseURL } : {}) }) : null;
// Vision-capable model for reading receipt/slip photos. Not every free/cheap model can read images —
// a text-only model will just fail (e.g. "openai/gpt-oss-120b" on OpenRouter is TEXT-ONLY, no image
// input — do not point OPENAI_VISION_MODEL at it). Working vision options (Aug 2026):
//   OpenRouter (free, tighter rate limits): "google/gemma-4-31b-it:free"
//   NVIDIA NIM (free, higher rate limits ~40 RPM, no ":free" suffix on model IDs): "google/gemma-4-31b-it"
//   OpenAI direct (paid): "gpt-4o-mini" / "gpt-4.1-mini"
// Falls back to OPENAI_MODEL if no separate vision model is set.
const visionModel = process.env.OPENAI_VISION_MODEL ?? process.env.OPENAI_MODEL;

// ---------------------------------------------------------------------------
// Premium subscription + payment system (see docs/ARCHITECTURE.md)
// ---------------------------------------------------------------------------
const subCollections = buildSubscriptionCollections(firebaseApp);
const auditLog = createAuditLogger(subCollections);
const subscriptionService = createSubscriptionService(subCollections, auditLog);
const paymentSessionService = createPaymentSessionService(subCollections, auditLog);
const uploadSessionService = createUploadSessionService(subCollections);
const paymentTransactionService = createPaymentTransactionService(subCollections, {
  auditLog,
  paymentProvider: getPaymentProvider(),
  subscriptionService
});
const qrService = createQrService();
const richMenuService = createRichMenuService();
function buildQrImageUrl(sessionId) {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  return base ? `${base}/qr/${sessionId}.png` : null;
}
const subLineHandlers = createSubscriptionLineHandlers({
  subscriptionService,
  paymentSessionService,
  uploadSessionService,
  paymentTransactionService,
  richMenuService,
  qrService,
  auditLog,
  ai,
  visionModel,
  buildQrImageUrl
});
const adminAuth = createAdminAuth(subCollections);
app.use("/admin", createAdminRouter({ collections: subCollections, adminAuth, subscriptionService, paymentTransactionService }));

// ---------------------------------------------------------------------------
// กลุ่มจดบัญชี (group ledger): บอทเข้ากลุ่มได้เฉพาะที่มีคนยืนยันว่าเป็นเจ้าของ Premium เท่านั้น
// ทุกคำสั่ง/ข้อความในกลุ่ม-ห้อง ต้องขึ้นต้นด้วย "/บอท" เสมอ ไม่งั้นบอทจะไม่ตอบ (ดู docs/ARCHITECTURE.md)
// ---------------------------------------------------------------------------
const groupLinkService = createGroupLinkService(subCollections, auditLog, subscriptionService);
const BOT_PREFIX = "/บอท";
function stripBotPrefix(text) {
  if (!text.startsWith(BOT_PREFIX)) return null;
  return text.slice(BOT_PREFIX.length).trim();
}

// housekeeping: mark expired subscriptions daily (NOT the source of truth for access control —
// isPremium() always re-checks expires_at live against server time, see spec §13)
cron.schedule("15 0 * * *", async () => {
  try { const count = await subscriptionService.sweepExpired(); if (count) console.log(`Expired ${count} subscription(s)`); }
  catch (error) { console.error("Subscription expiry sweep failed:", error.message); }
}, { timezone: "Asia/Bangkok" });

// housekeeping: กลุ่มที่ยังไม่มีใครยืนยันเป็นเจ้าของภายในเวลาที่กำหนด (CONFIRM_WINDOW_MINUTES) ให้บอทออกจากกลุ่มเอง
// รันถี่กว่า sweep ปกติเพราะ deadline สั้นแค่ไม่กี่นาที (ตรวจทุก 2 นาทีพอ ไม่ต้องเรียลไทม์เป๊ะ)
cron.schedule("*/2 * * * *", async () => {
  try {
    const expiredGroupIds = await groupLinkService.findExpiredPending();
    for (const groupId of expiredGroupIds) {
      try {
        await leaveGroup(groupId);
        await groupLinkService.markLeft(groupId);
        console.log(`Left group ${groupId}: no owner confirmation within ${CONFIRM_WINDOW_MINUTES} min`);
      } catch (error) { console.error(`Leaving group ${groupId} failed:`, error.message); }
    }
  } catch (error) { console.error("Group pending sweep failed:", error.message); }
}, { timezone: "Asia/Bangkok" });

const CATEGORIES = {
  "อาหาร": ["กาแฟ", "ข้าว", "อาหาร", "กิน", "ร้าน", "น้ำ", "ชา"],
  "เดินทาง": ["รถ", "น้ำมัน", "แท็กซี่", "bts", "mrt", "grab", "ที่จอด"],
  "บิล": ["ค่าไฟ", "ค่าน้ำ", "เน็ต", "โทรศัพท์", "บิล", "ประกัน"],
  "สุขภาพ": ["ยา", "หมอ", "โรงพยาบาล", "ฟิตเนส"],
  "บันเทิง": ["เกม", "หนัง", "เที่ยว", "คอนเสิร์ต", "spotify", "netflix"],
  "ช้อปปิ้ง": ["ช้อป", "ซื้อ", "ของใช้", "เสื้อ", "รองเท้า"],
  "อื่น ๆ": []
};
const INCOME_WORDS = ["เงินเดือน", "รายรับ", "รายได้", "โบนัส", "ขาย", "ได้เงิน", "คืนเงิน", "ดอกเบี้ย", "กำไร", "ค่าจ้าง", "จดรับ", "บันทึกรับ", "รับเงิน", "เงินเข้า", "โอนเข้า"];
// คำนำหน้าสั้น ๆ ที่หมายถึง "นี่คือรายรับ" เช่น "รับ 30", "+30", "จดรับ30"
const INCOME_PREFIX = /^(?:\+|รับ)\s*(?=[0-9])|^จดรับ\s*(?=[0-9]|\s)/;

// confirmMessagePrefs: ปรับแต่งการ์ด "จดสำเร็จ" (txFlexMessage) — ฟีเจอร์ Premium ใช้ได้ทั้งกลุ่มและแชทส่วนตัว 1:1 (ดู /api/confirm-message-prefs)
// ค่า default ทุกตัว = พฤติกรรมเดิมของการ์ด (เปิดหมด, ธีมชมพู) เพื่อไม่กระทบผู้ใช้เก่าที่ยังไม่เคยตั้งค่า
function defaultConfirmMessagePrefs() { return { showBudgetBar: true, showAuthorName: true, showEditButton: true, showDeleteButton: true, theme: "pink" }; }
function emptyUser() { return { transactions: [], recurring: [], budgets: {}, dailyReminder: false, reminderTime: "20:00", confirmMessagePrefs: defaultConfirmMessagePrefs() }; }
async function getUser(uid) {
  const snap = await usersCol.doc(String(uid)).get();
  return snap.exists ? { ...emptyUser(), ...snap.data() } : emptyUser();
}
async function saveUser(uid, user) { await usersCol.doc(String(uid)).set(user); }
function perUserToken(uid) { return crypto.createHmac("sha256", process.env.DASHBOARD_TOKEN ?? "").update(String(uid)).digest("hex").slice(0, 32); }
function money(value) { return new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2 }).format(value); }
function parts(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return null;
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value).map(({ type, value }) => [type, value]));
}
function sameDay(date) { const a = parts(date), b = parts(); return Boolean(a && b && a.year === b.year && a.month === b.month && a.day === b.day); }
function sameMonth(date, year = parts().year, month = parts().month) { const p = parts(date); return Boolean(p && p.year === year && p.month === month); }
function totals(list) { return list.reduce((x, tx) => ({ income: x.income + (tx.type === "income" ? tx.amount : 0), expense: x.expense + (tx.type === "expense" ? tx.amount : 0) }), { income: 0, expense: 0 }); }
function categoryFor(text) { const lower = text.toLowerCase(); return Object.entries(CATEGORIES).find(([, words]) => words.some((word) => lower.includes(word)))?.[0] ?? "อื่น ๆ"; }
// คำที่ส่งสัญญาณว่าเป็น "คำถาม/ขอคำปรึกษา" ไม่ใช่การจดรายการ แม้จะไม่มีเครื่องหมาย ? หรือคำถามชัด ๆ
const QUESTION_HINTS = /[?？]|ไหม|หรือเปล่า|หรือไม่|หรือยัง|ทำไม|ยังไง|อย่างไร|เท่าไหร่|เท่าไร|มั้ย|รึเปล่า|หรือป่าว|ช่วย|หน่อย|แนะนำ|วางแผน|ควร(?:จะ)?|คิดว่า|ดีไหม|ดีมั้ย|ยังไงดี|ทำยังไง|อยากรู้|อยากถาม|บ้าง(?:คะ|ครับ)?$|มีอะไรบ้าง/;
function looksLikeQuestion(text) {
  if (QUESTION_HINTS.test(text)) return true;
  // ประโยคยาว (เกิน 4 คำ) ที่ไม่มีสกุลเงินกำกับชัดเจน (฿/บาท ติดกับตัวเลข) มีแนวโน้มเป็นประโยคคุย/คำถามมากกว่ารายการจด
  // (รายการจดจริง ๆ มักสั้น เช่น "กาแฟ 60" ไม่ใช่ประโยคยาวหลายคำ)
  const trimmed = text.trim();
  const hasExplicitCurrency = /(?:฿|บาท)\s*[0-9]|[0-9][0-9,]*(?:\.\d{1,2})?\s*(?:฿|บาท)/.test(trimmed);
  if (!hasExplicitCurrency && trimmed.split(/\s+/).length > 4) return true;
  return false;
}
function parse(text) {
  const trimmed = text.trim();
  if (looksLikeQuestion(trimmed)) return null;
  // require an explicit currency marker (฿ / บาท) next to the number ...
  let hit = trimmed.match(/(?:฿|บาท)\s*([0-9][0-9,]*(?:\.\d{1,2})?)/) ?? trimmed.match(/([0-9][0-9,]*(?:\.\d{1,2})?)\s*(?:฿|บาท)/);
  // ...or fall back to a short "item amount" style entry only (e.g. "กาแฟ 60"), never a long sentence
  if (!hit && trimmed.split(/\s+/).length <= 4) hit = trimmed.match(/([0-9][0-9,]*(?:\.\d{1,2})?)/);
  if (!hit) return null;
  const amount = Number(hit[1].replaceAll(",", ""));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) return null;
  const matchedIncomeSignal = INCOME_PREFIX.test(trimmed) || INCOME_WORDS.some((word) => trimmed.toLowerCase().includes(word));
  const income = matchedIncomeSignal;
  const description = trimmed.replace(hit[0], "").replace(/^(รายรับ|รายจ่าย|จดรับ|จดจ่าย|รับ|\+)\s*/i, "").trim() || (income ? "รายรับ" : "รายจ่าย");
  // ambiguous = no explicit income/expense keyword or prefix matched, so we fell back to the "expense by default" guess
  const typeAmbiguous = !matchedIncomeSignal;
  return { id: crypto.randomUUID(), type: income ? "income" : "expense", category: income ? "รายรับ" : categoryFor(trimmed), description, amount, createdAt: new Date().toISOString(), _typeAmbiguous: typeAmbiguous };
}
// รวม "จำแนกรายรับ/รายจ่าย" (เมื่อกำกวม) และ "จำแนกหมวดหมู่" (เมื่อยังเป็น "อื่น ๆ") ให้เป็น AI call เดียว
// เดิมยิง 2 ครั้งติดกัน (sequential) ทำให้แชท 1:1 ตอบช้าลงเท่าตัวในเคสที่ทั้งกำกวมและหมวดไม่ชัด
async function enrichWithAi(tx, source, typeWasAmbiguous) {
  const needType = typeWasAmbiguous;
  const needCategory = tx.type === "expense" && tx.category === "อื่น ๆ";
  if (!ai || !process.env.OPENAI_MODEL || (!needType && !needCategory)) return tx;
  try {
    const instructions = [];
    if (needType) instructions.push('"type": ตัดสินว่าข้อความนี้เป็น "income" (เงินเข้า/รายรับ) หรือ "expense" (เงินออก/รายจ่าย)');
    // เดิมบังคับเลือกจาก 7 หมวดคงที่เท่านั้น (Object.hasOwn(CATEGORIES, ...) กรองทิ้งถ้าไม่ตรง) ทำให้รายจ่ายที่ไม่เข้าหมวดไหนเลย
    // ถูกจัดเป็น "อื่น ๆ" เสมอ แม้ผู้ใช้จะพิมพ์ชัดเจนแค่ไหนก็ตาม (เช่น "ค่าเลี้ยงลูก", "ค่าเทอม", "ทำบุญ") ตอนนี้ให้ AI ตั้งชื่อหมวดใหม่ได้เอง
    // ถ้าเข้ากับหมวดเดิม (อาหาร/เดินทาง/บิล/สุขภาพ/บันเทิง/ช้อปปิ้ง) ให้ใช้หมวดเดิมต่อ (กันหมวดเดียวกันแตกเป็นหลายชื่อโดยไม่จำเป็น
    // เช่น "อาหาร" กับ "ค่ากิน" ควรเป็นหมวดเดียวกัน) ใช้เฉพาะตอนไม่เข้าหมวดไหนจริง ๆ เท่านั้นถึงตั้งชื่อหมวดใหม่สั้น ๆ ให้
    if (needCategory) instructions.push(`"category": จัดหมวดรายจ่ายนี้ (ใส่เฉพาะกรณีเป็นรายจ่ายเท่านั้น) — ถ้าเข้ากับหมวดใดหมวดหนึ่งใน ${Object.keys(CATEGORIES).filter((c) => c !== "อื่น ๆ").join(", ")} ให้ใช้ชื่อหมวดเดิมนั้นเป๊ะ ๆ แต่ถ้าไม่เข้าหมวดไหนเลยจริง ๆ ให้ตั้งชื่อหมวดใหม่สั้น ๆ ภาษาไทยเอง (1-3 คำ ไม่ต้องมีคำว่า "ค่า" นำหน้าถ้าไม่จำเป็น เช่น "เลี้ยงลูก" "การศึกษา" "ทำบุญ") ห้ามใช้ "อื่น ๆ" ถ้าพอเดาความหมายของรายการได้`);
    const fields = [needType ? '"type":"income"|"expense"' : null, needCategory ? '"category":"..."' : null].filter(Boolean).join(", ");
    const completion = await ai.chat.completions.create({
      model: process.env.OPENAI_MODEL,
      temperature: 0,
      max_tokens: 40, // เอาต์พุตเป็น JSON เล็ก ๆ แค่ {"type":"...","category":"..."} เท่านั้น ไม่ต้องเผื่อพื้นที่มาก
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `ข้อความนี้เป็นการจดบันทึกทางการเงินสั้น ๆ ภาษาไทย ให้ตอบ JSON เท่านั้นตามฟิลด์ที่ร้องขอ:\n${instructions.join("\n")}\nรูปแบบ: {${fields}}` },
        { role: "user", content: source }
      ]
    });
    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}");
    let next = tx;
    if (needType && (parsed.type === "income" || parsed.type === "expense") && parsed.type !== next.type) {
      next = { ...next, type: parsed.type, category: parsed.type === "income" ? "รายรับ" : categoryFor(source) };
    }
    // รับชื่อหมวดจาก AI ได้ทั้งหมวดเดิม (Object.hasOwn) และหมวดใหม่ที่ AI ตั้งเอง — validate ขั้นต่ำกันขยะ/พัง:
    // ต้องเป็น string, ไม่ว่างหลัง trim, ไม่ยาวเกินไป (กัน AI หลุดตอบเป็นประโยคยาวแทนชื่อหมวด), ไม่ใช่ "อื่น ๆ" ซ้ำ (ไม่มีประโยชน์)
    if (needCategory && next.type === "expense" && typeof parsed.category === "string") {
      const proposedCategory = parsed.category.trim().slice(0, 20);
      if (proposedCategory && proposedCategory !== "อื่น ๆ") next = { ...next, category: proposedCategory };
    }
    return next;
  } catch (error) { console.warn("AI enrichment skipped:", error.message); return tx; }
}
function advice(monthTransactions) {
  const expenses = monthTransactions.filter((tx) => tx.type === "expense");
  if (expenses.length < 3) return "คำแนะนำ: บันทึกรายการต่อเนื่องอีกนิด ยายจันทร์จะช่วยดูพฤติกรรมการใช้เงินให้";
  const groups = expenses.reduce((out, tx) => ({ ...out, [tx.category]: (out[tx.category] ?? 0) + tx.amount }), {});
  const [category, value] = Object.entries(groups).sort((a, b) => b[1] - a[1])[0];
  return `คำแนะนำ: เดือนนี้ใช้หมวด${category}มากสุด ${money(value)} บาท ลองตั้งวงเงินหมวดนี้ไว้ดูนะ`;
}
function summary(list, title) { const t = totals(list); return `📊 สรุป${title}\nรายรับ: ${money(t.income)} บาท\nรายจ่าย: ${money(t.expense)} บาท\nคงเหลือ: ${money(t.income - t.expense)} บาท\nจำนวนรายการ: ${list.length}`; }
function signatureValid(raw, signature) { const expected = crypto.createHmac("sha256", process.env.LINE_CHANNEL_SECRET).update(raw).digest("base64"); return Boolean(signature) && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); }
async function line(endpoint, body) { const r = await fetch(`https://api.line.me/v2/bot/message/${endpoint}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }, body: JSON.stringify(body) }); if (!r.ok) { const detail = await r.text().catch(() => ""); throw new Error(`LINE ${endpoint}: ${r.status} ${detail}`); } }
// แสดง "..." กำลังพิมพ์ในแชท ระหว่างรอ AI อ่านสลิป — ใช้ได้เฉพาะแชท 1:1 เท่านั้น (LINE ไม่รองรับในกลุ่ม/ห้อง)
// จะหายไปเองตอนบอทตอบกลับ (reply) หรือหมดเวลาตาม loadingSeconds แล้วแต่ว่าอันไหนถึงก่อน จึงไม่ต้องมีฟังก์ชันหยุดแยก
// ยิงแบบ fire-and-forget เสมอ (ไม่ await ตรง call site) เพราะแค่พลาดแล้วไม่มี loading โชว์ ไม่ควรทำให้ทั้ง flow ล้ม
async function startLoadingAnimation(chatId, loadingSeconds = 20) {
  try {
    const r = await fetch("https://api.line.me/v2/bot/chat/loading/start", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` },
      body: JSON.stringify({ chatId, loadingSeconds }),
    });
    if (!r.ok) console.warn(`LINE loading animation failed: ${r.status}`);
  } catch (error) { console.warn("LINE loading animation failed:", error.message); }
}
async function replyMessages(token, messages) { return line("reply", { replyToken: token, messages }); }
async function reply(token, text) { return replyMessages(token, [{ type: "text", text: text.slice(0, 4900) }]); }
async function push(to, message) { const messages = typeof message === "string" ? [{ type: "text", text: message.slice(0, 4900) }] : [message]; return line("push", { to, messages }); }
function qrImageMessage(url) { return { type: "image", originalContentUrl: url, previewImageUrl: url }; }

// ชุดธีมสีของการ์ด "จดสำเร็จ" — ปรับได้จากหน้าตั้งค่า (ดู /api/confirm-message-prefs), ค่า default คือ "pink" (สีเดิมของการ์ดก่อนมีฟีเจอร์นี้)
// accent = สีหลัก (แท็กประเภท/ตัวเลขเงิน/แถบงบ), accentSoft = พื้นหลังแท็กหมวดหมู่, accentDeep = สีแถบงบตอนเกินงบ, cream = พื้นหลังการ์ด
// พื้นหลังการ์ด (cream) ใช้สีเดียวกันทุกธีมเสมอ — เปลี่ยนธีมมีผลแค่สีข้อความ/แท็ก/ปุ่ม (accent, accentSoft, accentDeep) เท่านั้น
// ไม่แตะพื้นหลัง เพื่อให้การ์ดยังคงอ่านง่ายสม่ำเสมอไม่ว่าจะเลือกธีมไหน (เดิมแต่ละธีมมี cream เป็นสีของตัวเอง ทำให้พื้นหลังเปลี่ยนเฉด
// เล็กน้อยตามธีมไปด้วย ซึ่งไม่ใช่พฤติกรรมที่ต้องการ)
const CARD_CREAM = "#FBF3EC";
const CONFIRM_MESSAGE_THEMES = {
  pink: { accent: "#D23283", accentSoft: "#FCE4EF", accentDeep: "#B0225F", cream: CARD_CREAM },
  green: { accent: "#4B6A58", accentSoft: "#E7EFE8", accentDeep: "#33493C", cream: CARD_CREAM },
  brown: { accent: "#8A5A3B", accentSoft: "#F1E4D8", accentDeep: "#623F29", cream: CARD_CREAM },
  gold: { accent: "#A6772E", accentSoft: "#F5ECD9", accentDeep: "#7A5820", cream: CARD_CREAM },
  purple: { accent: "#7B5AA6", accentSoft: "#EAE3F5", accentDeep: "#5A3F80", cream: CARD_CREAM },
  orange: { accent: "#D2662E", accentSoft: "#FCE6D8", accentDeep: "#A8501F", cream: CARD_CREAM }
};
function confirmMessageTheme(name) { return CONFIRM_MESSAGE_THEMES[name] ?? CONFIRM_MESSAGE_THEMES.pink; }

// การ์ด Flex Message แสดงผลตอนจดรายการสำเร็จ (แทนข้อความ text ธรรมดา)
// tx: รายการที่เพิ่งบันทึก, opts.budget: { limit, spent } หมวดนี้ในเดือนนี้ (ถ้ามีตั้งงบไว้), opts.dashboardUrl: ลิงก์แก้ไขผ่านเว็บ, opts.userId: เจ้าของบัญชี (ใช้ผูกปุ่มลบ)
// opts.prefs: confirmMessagePrefs ของ user (ดู defaultConfirmMessagePrefs) — คุมว่าจะโชว์แถบงบ/ชื่อผู้จด/ปุ่มแก้ไข/ปุ่มลบ และธีมสีไหน
// ไม่ส่ง opts.prefs มา = fallback เป็นค่า default ทั้งหมด (พฤติกรรมเดิมก่อนมีฟีเจอร์นี้ ไม่กระทบ user เก่า)
function txFlexMessage(tx, opts = {}) {
  const isIncome = tx.type === "income";
  const typeLabel = isIncome ? "รายรับ" : "รายจ่าย";
  const prefs = { ...defaultConfirmMessagePrefs(), ...(opts.prefs ?? {}) };
  const { accent: pink, accentSoft: pinkSoft, accentDeep: pinkDeep, cream } = confirmMessageTheme(prefs.theme);
  const { budget, dashboardUrl, userId } = opts;

  const bodyContents = [
    // แถวแท็ก: ประเภท + หมวดหมู่ (พื้นชมพู ตัวอักษรขาว) — กล่องสีพื้นหลังต้องอยู่บน box ไม่ใช่ text โดยตรง
    {
      type: "box",
      layout: "horizontal",
      spacing: "sm",
      contents: [
        {
          type: "box",
          layout: "vertical",
          backgroundColor: pink,
          cornerRadius: "12px",
          paddingAll: "6px",
          paddingStart: "10px",
          paddingEnd: "10px",
          flex: 0,
          contents: [
            { type: "text", text: typeLabel, size: "xs", weight: "bold", color: "#FFFFFF", align: "center", gravity: "center" }
          ]
        },
        {
          type: "box",
          layout: "vertical",
          backgroundColor: pinkSoft,
          cornerRadius: "12px",
          paddingAll: "6px",
          paddingStart: "10px",
          paddingEnd: "10px",
          flex: 0,
          contents: [
            { type: "text", text: tx.category, size: "xs", weight: "bold", color: pink, align: "center", gravity: "center" }
          ]
        },
        { type: "filler" }
      ]
    },
    // ชื่อรายการ
    { type: "text", text: tx.description || typeLabel, size: "md", weight: "bold", color: "#3A3540", margin: "md", wrap: true },
    (prefs.showAuthorName && tx.authorName) ? { type: "text", text: `ผู้จด: ${tx.authorName}`, size: "xs", color: "#9B94A0", margin: "xs" } : null,
    { type: "separator", margin: "lg", color: "#EFE3D8" },
    // จำนวนเงินตัวใหญ่สีชมพู
    {
      type: "box",
      layout: "vertical",
      margin: "lg",
      contents: [
        { type: "text", text: "จำนวนเงิน", size: "xs", color: "#9B94A0" },
        { type: "text", text: `${isIncome ? "+" : "-"}${money(tx.amount)} บาท`, size: "xxl", weight: "bold", color: pink, margin: "xs" }
      ]
    }
  ].filter(Boolean);

  // แถบ progress bar เทียบยอดรวม (หมวดนี้/เดือนนี้) กับงบที่ตั้งไว้ — แสดงเฉพาะรายจ่ายที่มีการตั้งงบหมวดนี้ และเปิด showBudgetBar ไว้
  if (prefs.showBudgetBar && !isIncome && budget && budget.limit > 0) {
    const ratio = Math.min(budget.spent / budget.limit, 1);
    const overBudget = budget.spent > budget.limit;
    bodyContents.push(
      { type: "separator", margin: "lg", color: "#EFE3D8" },
      {
        type: "box",
        layout: "vertical",
        margin: "lg",
        spacing: "xs",
        contents: [
          {
            type: "box",
            layout: "horizontal",
            contents: [
              { type: "text", text: `งบ${tx.category}เดือนนี้`, size: "xs", color: "#9B94A0", flex: 1 },
              { type: "text", text: `${money(budget.spent)} / ${money(budget.limit)} บาท`, size: "xs", color: overBudget ? pink : "#9B94A0", align: "end" }
            ]
          },
          {
            type: "box",
            layout: "horizontal",
            height: "8px",
            cornerRadius: "4px",
            contents: [
              { type: "box", layout: "vertical", flex: Math.max(Math.round(ratio * 100), 4), backgroundColor: overBudget ? pinkDeep : pink, contents: [] },
              { type: "box", layout: "vertical", flex: Math.max(100 - Math.round(ratio * 100), 0), backgroundColor: "#F1E7DC", contents: [] }
            ]
          },
          overBudget ? { type: "text", text: "เกินงบที่ตั้งไว้แล้วนะ", size: "xxs", color: pinkDeep, margin: "xs" } : null
        ].filter(Boolean)
      }
    );
  }

  const footerButtons = [];
  if (prefs.showEditButton && dashboardUrl) {
    footerButtons.push({ type: "button", style: "secondary", height: "sm", color: "#F1E7DC", action: { type: "uri", label: "แก้ไข", uri: dashboardUrl } });
  }
  // ปุ่ม "ลบ": ยิง postback กลับมาให้บอทลบรายการนี้ทันที (ไม่เปิดเว็บ, ไม่ถามยืนยันซ้ำ)
  if (prefs.showDeleteButton && userId && tx.id) {
    // displayText เว้นว่างไว้ตั้งใจ: กันไม่ให้มีข้อความ "ลบรายการนี้" เด้งขึ้นฝั่งเราเองตอนกด (จะรกแชท)
    footerButtons.push({ type: "button", style: "secondary", height: "sm", color: pinkSoft, action: { type: "postback", label: "ลบ", data: `delete_tx=${tx.id}&u=${encodeURIComponent(userId)}`, displayText: "\u200b" } });
  }

  return {
    type: "flex",
    altText: `จดสำเร็จ: ${tx.description || typeLabel} ${money(tx.amount)} บาท`,
    contents: {
      type: "bubble",
      size: "kilo",
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: cream,
        paddingAll: "20px",
        contents: [
          { type: "text", text: "จดสำเร็จ ✅", size: "lg", weight: "bold", color: "#3A3540" },
          { type: "box", layout: "vertical", margin: "md", spacing: "sm", contents: bodyContents }
        ]
      },
      footer: footerButtons.length
        ? { type: "box", layout: "horizontal", spacing: "sm", paddingAll: "12px", backgroundColor: cream, contents: footerButtons }
        : undefined
    }
  };
}
// การ์ด Flex Message ถามยืนยันประเภท "รายรับ/รายจ่าย" หลังอ่านสลิปเสร็จ — ยังไม่บันทึกจริงจนกว่าจะกดปุ่ม
// receipt: { merchant, amount } จาก readReceipt, meta: { authorId } (มีเฉพาะในกลุ่ม)
// ข้อมูลที่ต้องใช้ต่อถูกเข้ารหัสไว้ใน postback data ตรง ๆ (ไม่ผ่าน session ฝั่งเซิร์ฟเวอร์) เพราะเป็นข้อมูลเล็กและอายุสั้น
function receiptConfirmFlexMessage(receipt, meta = {}) {
  const pink = "#D23283";
  const cream = "#FBF3EC";
  const merchant = String(receipt.merchant ?? "อื่น ๆ").slice(0, 60); // ใช้ตัวเต็มแค่ตอนแสดงผลในการ์ด
  // LINE postback data จำกัดไม่เกิน 300 ตัวอักษร ภาษาไทย 1 ตัวอักษร URL-encode แล้วกินพื้นที่ ~9 ไบต์
  // ตัด merchant เหลือ 15 ตัวในพารามิเตอร์ m (คนละตัวกับ merchant ด้านบนที่ใช้แสดงผล) กันเกิน limit ตอนรวมกับ slip_step/aid/c (เพิ่มมาใหม่)
  const payloadMerchant = merchant.slice(0, 15);
  // "รายจ่าย" ไม่บันทึกทันทีอีกต่อไป -> ไปที่ slip_step=category ก่อน (ดู categoryPickerFlexMessage) ให้เลือกหมวดก่อนค่อยบันทึกจริง
  // "รายรับ" ยังบันทึกทันทีเหมือนเดิม เพราะรายรับไม่มีแนวคิดเรื่องหมวดหมู่ในระบบนี้ (category ถูกตั้งเป็น "รายรับ" คงที่เสมอ)
  const payload = (step, type) => `slip_step=${step}&slip_type=${type}&m=${encodeURIComponent(payloadMerchant)}&a=${receipt.amount}${meta.authorId ? `&aid=${meta.authorId}` : ""}`;
  return {
    type: "flex",
    altText: `อ่านสลิปได้ ${money(receipt.amount)} บาท — เป็นรายรับหรือรายจ่าย?`,
    contents: {
      type: "bubble",
      size: "kilo",
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: cream,
        paddingAll: "20px",
        contents: [
          { type: "text", text: "อ่านสลิปสำเร็จ 🧾", size: "lg", weight: "bold", color: "#3A3540" },
          { type: "text", text: merchant, size: "md", weight: "bold", color: "#3A3540", margin: "md", wrap: true },
          { type: "text", text: `${money(receipt.amount)} บาท`, size: "xxl", weight: "bold", color: pink, margin: "xs" },
          { type: "separator", margin: "lg", color: "#EFE3D8" },
          { type: "text", text: "รายการนี้เป็นรายรับหรือรายจ่าย?", size: "sm", color: "#9B94A0", margin: "lg" }
        ]
      },
      footer: {
        type: "box",
        layout: "horizontal",
        spacing: "sm",
        paddingAll: "12px",
        backgroundColor: cream,
        contents: [
          { type: "button", style: "primary", height: "sm", color: pink, action: { type: "postback", label: "รายจ่าย", data: payload("category", "expense"), displayText: "รายจ่าย" } },
          { type: "button", style: "secondary", height: "sm", color: "#F1E7DC", action: { type: "postback", label: "รายรับ", data: payload("save", "income"), displayText: "รายรับ" } }
        ]
      }
    }
  };
}
// การ์ดเลือกหมวดหมู่ — โผล่หลังกดปุ่ม "รายจ่าย" บนการ์ดยืนยันสลิป (ก่อนหน้านี้กดปุ่ม "รายจ่าย" แล้วบันทึกเลย
// ให้ categoryFor()/enrichWithAi ตัดสินหมวดเอาเองทั้งหมด ตอนนี้เปิดให้ผู้ใช้เลือกเองก่อนได้ ลดโอกาสตกไปเป็น "อื่น ๆ" ผิด ๆ)
// เลือก "ให้ยายเลือกให้" ได้ ถ้าไม่อยากเลือกเอง -> ทำงานเหมือนพฤติกรรมเดิมทุกอย่าง (keyword match + AI ช่วยตัดสินตอน "อื่น ๆ")
function categoryPickerFlexMessage(merchant, amount, meta = {}) {
  const pink = "#D23283";
  const cream = "#FBF3EC";
  const displayMerchant = String(merchant ?? "อื่น ๆ").slice(0, 60); // ใช้ตัวเต็มแค่ตอนแสดงผลในการ์ด
  // ตัด merchant ให้สั้นลงเหลือ 15 ตัวอักษรตอนใส่ใน postback data เท่านั้น (คนละตัวกับ displayMerchant ด้านบน, เท่ากับ limit ที่ใช้ใน receiptConfirmFlexMessage)
  // เพราะภาษาไทย 1 ตัวอักษร URL-encode แล้วกินพื้นที่ ~9 ไบต์ ถ้าปล่อยยาวเกินไปรวมกับ slip_step/c/aid จะเกิน 300 ตัวอักษรที่ LINE postback data รับได้
  const payloadMerchant = String(merchant ?? "อื่น ๆ").slice(0, 15);
  const payload = (category) => `slip_step=save&slip_type=expense&m=${encodeURIComponent(payloadMerchant)}&a=${amount}&c=${encodeURIComponent(category)}${meta.authorId ? `&aid=${meta.authorId}` : ""}`;
  const categoryLabels = Object.keys(CATEGORIES).filter((c) => c !== "อื่น ๆ"); // "อื่น ๆ" ไม่ต้องมีปุ่มเฉพาะ ใช้ปุ่ม "ให้ยายเลือกให้" แทน (ครอบคลุมเคสนี้อยู่แล้ว)
  const categoryButtons = categoryLabels.map((label) => ({
    type: "button", style: "secondary", height: "sm", color: "#F1E7DC",
    action: { type: "postback", label, data: payload(label), displayText: label }
  }));
  return {
    type: "flex",
    altText: `${displayMerchant} ${money(amount)} บาท — เลือกหมวดหมู่รายจ่าย`,
    contents: {
      type: "bubble",
      size: "kilo",
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: cream,
        paddingAll: "20px",
        contents: [
          { type: "text", text: displayMerchant, size: "md", weight: "bold", color: "#3A3540", wrap: true },
          { type: "text", text: `${money(amount)} บาท`, size: "xl", weight: "bold", color: pink, margin: "xs" },
          { type: "separator", margin: "lg", color: "#EFE3D8" },
          { type: "text", text: "รายจ่ายนี้เป็นหมวดไหน?", size: "sm", color: "#9B94A0", margin: "lg" },
          {
            type: "box", layout: "vertical", spacing: "sm", margin: "md",
            contents: [
              // จัดปุ่มเป็นแถวละ 2 ปุ่ม อ่านง่ายกว่าเรียงแนวตั้งยาว ๆ ทีละปุ่ม
              ...Array.from({ length: Math.ceil(categoryButtons.length / 2) }, (_, i) => ({
                type: "box", layout: "horizontal", spacing: "sm",
                contents: categoryButtons.slice(i * 2, i * 2 + 2)
              }))
            ]
          }
        ]
      },
      footer: {
        type: "box", layout: "vertical", paddingAll: "12px", backgroundColor: cream,
        contents: [
          { type: "button", style: "primary", height: "sm", color: pink, action: { type: "postback", label: "ให้ยายเลือกให้ 👵", data: payload(""), displayText: "ให้ยายเลือกให้" } }
        ]
      }
    }
  };
}
// สร้างและบันทึกรายการจากสลิปที่ยืนยันประเภทแล้ว (เรียกจาก postback handler)
// merchant/amount มาจาก postback data ที่ผู้ใช้กดยืนยัน, type คือ "income" | "expense"
// category: ถ้าผู้ใช้เลือกเองจาก categoryPickerFlexMessage จะส่งมาตรงนี้ ถ้าไม่ส่งมา (undefined/"") ให้ categoryFor()/enrichWithAi ตัดสินเองเหมือนเดิม
async function saveConfirmedSlipTx({ userId, type, merchant, amount, category, authorId, isGroupChat }) {
  const user = await getUser(userId);
  const resolvedCategory = type === "income" ? "รายรับ" : (category || categoryFor(merchant));
  let tx = { id: crypto.randomUUID(), type, category: resolvedCategory, description: merchant, amount, createdAt: new Date().toISOString() };
  // ถ้าผู้ใช้เลือกหมวดเองแล้ว ไม่ต้องให้ AI มาเดาซ้ำทับ (เฉพาะตอนยังเป็น "อื่น ๆ" หรือไม่ได้เลือกมาเท่านั้นถึงให้ AI ช่วย)
  if (type === "expense" && tx.category === "อื่น ๆ") tx = await enrichWithAi(tx, merchant);
  if (isGroupChat) tx = { ...tx, authorId, authorName: await getGroupMemberName(userId, authorId) };
  user.transactions.push(tx);
  await saveUser(userId, user);
  return { user, tx };
}
// การ์ด Flex Message สำหรับคำสั่ง "เว็บ" — สรุปยอดเดือนนี้แบบย่อ + ปุ่มใหญ่กดเข้าแดชบอร์ด
// แทนที่ข้อความ text ธรรมดา + ลิงก์ยาว ๆ แบบเดิม ให้ธีมตรงกับ txFlexMessage/receiptConfirmFlexMessage
function dashboardFlexMessage(user, { isGroupChat, dashboardUrl } = {}) {
  const pink = "#D23283";
  const cream = "#FBF3EC";
  const gold = "#C79A46";
  const month = user.transactions.filter((tx) => sameMonth(tx.createdAt));
  const t = totals(month);
  const balance = t.income - t.expense;
  const ratio = t.income > 0 ? Math.min(t.expense / t.income, 1) : (t.expense > 0 ? 1 : 0);
  const overspending = t.income > 0 && t.expense > t.income;
  const scopeLabel = isGroupChat ? "กองกลางของกลุ่มนี้" : "ของคุณเดือนนี้";

  return {
    type: "flex",
    altText: "เปิดแดชบอร์ด 📊 ดูสรุปบัญชีแบบเต็มรูปแบบได้ที่เว็บ",
    contents: {
      type: "bubble",
      size: "kilo",
      body: {
        type: "box",
        layout: "vertical",
        backgroundColor: cream,
        paddingAll: "20px",
        contents: [
          // หัวการ์ด: ไอคอนดวงตรา + ชื่อ
          {
            type: "box",
            layout: "horizontal",
            spacing: "sm",
            contents: [
              {
                type: "box", layout: "vertical", width: "34px", height: "34px", cornerRadius: "17px",
                backgroundColor: pink, justifyContent: "center", alignItems: "center",
                contents: [{ type: "text", text: "จ", size: "sm", weight: "bold", color: "#FFFFFF", align: "center", gravity: "center" }]
              },
              {
                type: "box", layout: "vertical", flex: 1, justifyContent: "center",
                contents: [
                  { type: "text", text: "แดชบอร์ด", size: "lg", weight: "bold", color: "#3A3540" },
                  { type: "text", text: scopeLabel, size: "xxs", color: "#9B94A0" }
                ]
              }
            ]
          },
          { type: "separator", margin: "lg", color: "#EFE3D8" },
          // สรุปรายรับ/รายจ่าย/คงเหลือ แบบย่อ
          {
            type: "box",
            layout: "horizontal",
            margin: "lg",
            contents: [
              { type: "box", layout: "vertical", flex: 1, contents: [
                { type: "text", text: "รายรับ", size: "xxs", color: "#9B94A0" },
                { type: "text", text: money(t.income), size: "md", weight: "bold", color: "#4B7A63", margin: "xs" }
              ] },
              { type: "box", layout: "vertical", flex: 1, contents: [
                { type: "text", text: "รายจ่าย", size: "xxs", color: "#9B94A0", align: "center" },
                { type: "text", text: money(t.expense), size: "md", weight: "bold", color: pink, align: "center", margin: "xs" }
              ] },
              { type: "box", layout: "vertical", flex: 1, contents: [
                { type: "text", text: "คงเหลือ", size: "xxs", color: "#9B94A0", align: "end" },
                { type: "text", text: money(balance), size: "md", weight: "bold", color: "#3A3540", align: "end", margin: "xs" }
              ] }
            ]
          },
          // แถบสัดส่วนรายจ่ายเทียบรายรับเดือนนี้ (เส้นบาง ๆ โทนทอง)
          {
            type: "box", layout: "horizontal", height: "6px", cornerRadius: "3px", margin: "md",
            contents: [
              { type: "box", layout: "vertical", flex: Math.max(Math.round(ratio * 100), ratio > 0 ? 3 : 0), backgroundColor: overspending ? pink : gold, contents: [] },
              { type: "box", layout: "vertical", flex: Math.max(100 - Math.round(ratio * 100), 0), backgroundColor: "#F1E7DC", contents: [] }
            ]
          },
          { type: "text", text: overspending ? "เดือนนี้ใช้เกินรายรับแล้วนะ" : `ใช้ไป ${Math.round(ratio * 100)}% ของรายรับเดือนนี้`, size: "xxs", color: overspending ? pink : "#9B94A0", margin: "sm" },
          { type: "separator", margin: "lg", color: "#EFE3D8" },
          { type: "text", text: "เปิดเว็บดูกราฟ ประวัติย้อนหลัง และตั้งงบประมาณแบบเต็ม ๆ ได้เลย", size: "xs", color: "#9B94A0", margin: "lg", wrap: true }
        ]
      },
      footer: dashboardUrl
        ? {
            type: "box", layout: "vertical", paddingAll: "12px", backgroundColor: cream,
            contents: [
              { type: "button", style: "primary", height: "sm", color: pink, action: { type: "uri", label: "เปิดแดชบอร์ด", uri: dashboardUrl } }
            ]
          }
        : {
            type: "box", layout: "vertical", paddingAll: "12px", backgroundColor: cream,
            contents: [{ type: "text", text: "ยังไม่ได้ตั้งค่า PUBLIC_BASE_URL สำหรับแดชบอร์ด", size: "xs", color: "#9B94A0", wrap: true }]
          }
    }
  };
}
// การ์ดต้อนรับตอนบอทถูกเชิญเข้ากลุ่ม/ห้อง (ใช้ธีมเดียวกับ dashboardFlexMessage — ครีม/ชมพู + ตรา "จ")
// ต้องมีใครยืนยันเป็น "เจ้าของ" ภายใน CONFIRM_WINDOW_MINUTES ไม่งั้นบอทออกจากกลุ่มเอง (ดู housekeeping cron ด้านบน)
// การ์ดต้อนรับตอนผู้ใช้แอดบอทเป็นเพื่อนใหม่ (1-1 chat) — คนละ flow กับ groupWelcomeFlexMessage ด้านล่าง (นั่นคือตอนถูกเชิญเข้ากลุ่ม)
// ในแชทเดี่ยวไม่ต้องมี "/บอท" นำหน้าคำสั่ง (จำกัดเฉพาะในกลุ่มเท่านั้น ดู BOT_PREFIX ด้านบน) เลยตัวอย่างคำสั่งในการ์ดนี้จะพิมพ์สั้น ๆ ได้เลย
function followWelcomeFlexMessage() {
  const pink = "#D23283", cream = "#FBF3EC";
  return {
    type: "flex",
    altText: `สวัสดีค่า ยายจันทร์มาแล้ว 👵 พิมพ์ "กาแฟ 60" เพื่อจดรายจ่ายแรกได้เลยนะ`,
    contents: {
      type: "bubble",
      body: {
        type: "box", layout: "vertical", paddingAll: "20px", backgroundColor: cream,
        contents: [
          {
            type: "box", layout: "horizontal", alignItems: "center", spacing: "md",
            contents: [
              { type: "box", layout: "vertical", width: "44px", height: "44px", cornerRadius: "22px", backgroundColor: pink, justifyContent: "center", alignItems: "center",
                contents: [{ type: "text", text: "จ", color: "#FFFFFF", weight: "bold", size: "lg", align: "center" }] },
              { type: "box", layout: "vertical", contents: [
                { type: "text", text: "สวัสดีค่า ยายจันทร์มาแล้ว 👵", weight: "bold", size: "md", color: "#2B2320", wrap: true },
                { type: "text", text: "สมุดบัญชีที่จดง่ายในแชท", size: "xxs", color: "#9B94A0" }
              ] }
            ]
          },
          { type: "separator", margin: "lg", color: "#EFE3D8" },
          { type: "text", text: "ยายช่วยจดรายรับ-รายจ่ายให้หลานได้เลย พิมพ์เป็นประโยคธรรมดา ยายเข้าใจเอง", size: "xs", color: "#5B5450", margin: "lg", wrap: true },
          {
            type: "box", layout: "vertical", margin: "lg", paddingAll: "12px", cornerRadius: "12px", backgroundColor: "#FFFFFF",
            contents: [
              { type: "text", text: "ลองพิมพ์ดูสิ", size: "xxs", color: "#9B94A0" },
              { type: "text", text: "กาแฟ 60", weight: "bold", size: "sm", color: pink, margin: "xs" },
              { type: "text", text: "เงินเดือน 15000", weight: "bold", size: "sm", color: pink, margin: "xs" }
            ]
          },
          { type: "text", text: "ถามยายได้ด้วยนะ เช่น \"เดือนนี้ใช้จ่ายอะไรเยอะสุด\" ยายจะดึงรายการมาสรุปให้เลย", size: "xxs", color: "#9B94A0", margin: "md", wrap: true }
        ]
      }
    }
  };
}

function groupWelcomeFlexMessage() {
  const pink = "#D23283", cream = "#FBF3EC";
  return {
    type: "flex",
    altText: `สวัสดีค่า ยายจันทร์มาแล้ว 👵 พิมพ์ "/บอท ยืนยันเจ้าของ" ภายใน ${CONFIRM_WINDOW_MINUTES} นาที เพื่อเริ่มใช้งานในกลุ่มนี้`,
    contents: {
      type: "bubble",
      body: {
        type: "box", layout: "vertical", paddingAll: "20px", backgroundColor: cream,
        contents: [
          {
            type: "box", layout: "horizontal", alignItems: "center", spacing: "md",
            contents: [
              { type: "box", layout: "vertical", width: "44px", height: "44px", cornerRadius: "22px", backgroundColor: pink, justifyContent: "center", alignItems: "center",
                contents: [{ type: "text", text: "จ", color: "#FFFFFF", weight: "bold", size: "lg", align: "center" }] },
              { type: "box", layout: "vertical", contents: [
                { type: "text", text: "สวัสดีค่า ยายจันทร์มาแล้ว 👵", weight: "bold", size: "md", color: "#2B2320", wrap: true },
                { type: "text", text: "สมุดบัญชีกลุ่มที่จดง่ายในแชท", size: "xxs", color: "#9B94A0" }
              ] }
            ]
          },
          { type: "separator", margin: "lg", color: "#EFE3D8" },
          { type: "text", text: "ฟีเจอร์นี้ใช้ได้เฉพาะกลุ่มที่มีสมาชิก Premium เชิญเข้ามาเท่านั้นนะคะ", size: "xs", color: pink, weight: "bold", margin: "lg", wrap: true },
          { type: "text", text: `ถ้าคุณเป็น Premium อยู่แล้ว ต้องมีคนพิมพ์ยืนยันก่อน ถึงจะเริ่มจดบัญชีในกลุ่มนี้ได้ (ภายใน ${CONFIRM_WINDOW_MINUTES} นาที ไม่งั้นยายจันทร์ขอตัวออกจากกลุ่มก่อนนะคะ)`, size: "xs", color: "#5B5450", margin: "sm", wrap: true },
          {
            type: "box", layout: "vertical", margin: "lg", paddingAll: "12px", cornerRadius: "12px", backgroundColor: "#FFFFFF",
            contents: [
              { type: "text", text: "พิมพ์ในกลุ่มนี้เลย", size: "xxs", color: "#9B94A0" },
              { type: "text", text: "/บอท ยืนยันเจ้าของ", weight: "bold", size: "sm", color: pink, margin: "xs" }
            ]
          },
          { type: "text", text: "หลังยืนยันแล้ว ทุกคำสั่งในกลุ่มต้องขึ้นต้นด้วย \"/บอท\" เสมอ เช่น /บอท กาแฟ 60", size: "xxs", color: "#9B94A0", margin: "md", wrap: true }
        ]
      }
    }
  };
}
// การ์ดแจ้งเตือนสั้น ๆ ทั่วไป (สำเร็จ/ผิดพลาด/แจ้งข้อมูล) แทนข้อความ text ล้วน — ใช้แทนที่ reply(token, "ข้อความยาว ๆ") เดิม
// tone: 'success' | 'error' | 'info' — คุมสีแถบด้านซ้ายกับไอคอนหัวการ์ดเท่านั้น เนื้อหายังเป็นข้อความปกติ ใส่ \n ได้ตามเดิม
function noticeFlexMessage(text, tone = "info") {
  const theme = {
    success: { icon: "✅", bar: "#4B6A58", altPrefix: "" },
    error: { icon: "⚠️", bar: "#7A2B3D", altPrefix: "" },
    info: { icon: "ℹ️", bar: "#D23283", altPrefix: "" },
  }[tone] ?? { icon: "ℹ️", bar: "#D23283" };
  return {
    type: "flex",
    altText: text.slice(0, 400),
    contents: {
      type: "bubble",
      body: {
        type: "box", layout: "horizontal", paddingAll: "16px", backgroundColor: "#FBF3EC",
        contents: [
          { type: "box", layout: "vertical", width: "4px", backgroundColor: theme.bar, cornerRadius: "2px", contents: [{ type: "filler" }] },
          { type: "box", layout: "vertical", paddingStart: "12px", spacing: "xs", contents: [
            { type: "text", text: theme.icon, size: "sm" },
            { type: "text", text: text.slice(0, 900), size: "sm", color: "#2B2320", wrap: true, margin: "xs" }
          ] }
        ]
      }
    }
  };
}

function budgetProgressFor(user, tx) {
  if (tx.type !== "expense") return null;
  const limit = user.budgets?.[tx.category];
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const spent = user.transactions.filter((t) => t.type === "expense" && t.category === tx.category && sameMonth(t.createdAt)).reduce((sum, t) => sum + t.amount, 0);
  return { limit, spent };
}
function dashboardEditUrl(userId) {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  return base ? `${base}/dashboard-gate?token=${perUserToken(userId)}&u=${encodeURIComponent(userId)}` : null;
}
// ดึงชื่อสมาชิกกลุ่ม (ใช้แสดง "ใครจดอะไรบ้าง" ในกองกลาง) — ใช้ได้เฉพาะ userId ที่เคยส่งข้อความในกลุ่มนี้มาก่อน
// (ข้อจำกัดของ LINE: ดึงรายชื่อสมาชิกกลุ่มทั้งหมดล่วงหน้าไม่ได้ ต้องรู้ userId ก่อนถึงจะสอบถามโปรไฟล์ได้)
async function getGroupMemberName(groupId, userId) {
  try {
    const r = await fetch(`https://api.line.me/v2/bot/group/${groupId}/member/${userId}`, { headers: { authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` } });
    if (!r.ok) return null;
    const profile = await r.json();
    return profile.displayName ?? null;
  } catch (error) { console.warn("Group member profile fetch failed:", error.message); return null; }
}
// เรียกตอนไม่มีใครยืนยันเป็นเจ้าของกลุ่มทันเวลา หรือคนที่ยืนยันไม่ใช่ Premium
async function leaveGroup(groupId) {
  const r = await fetch(`https://api.line.me/v2/bot/group/${groupId}/leave`, { method: "POST", headers: { authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` } });
  if (!r.ok) throw new Error(`LINE leaveGroup: ${r.status}`);
}
function allowed(req) {
  const uid = req.query.u;
  if (!process.env.DASHBOARD_TOKEN || !uid) return false;
  const given = String(req.query.token ?? ""), expected = perUserToken(uid);
  if (given.length !== expected.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected)); } catch { return false; }
}
async function askFinanceAi(user, question) {
  if (!ai || !process.env.OPENAI_MODEL) return null;
  try {
    const month = user.transactions.filter((tx) => sameMonth(tx.createdAt));
    const t = totals(month);
    const top = Object.entries(month.filter((tx) => tx.type === "expense").reduce((o, tx) => ({ ...o, [tx.category]: (o[tx.category] ?? 0) + tx.amount }), {})).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const budgetLines = Object.entries(user.budgets ?? {}).map(([category, amount]) => `${category}: งบ ${money(amount)} บาท`).join("\n") || "ยังไม่ได้ตั้งงบ";
    const context = `ข้อมูลบัญชีเดือนนี้ของผู้ใช้คนนี้เท่านั้น (ห้ามอ้างอิงคนอื่น):\nรายรับ: ${money(t.income)} บาท\nรายจ่าย: ${money(t.expense)} บาท\nคงเหลือ: ${money(t.income - t.expense)} บาท\nหมวดที่ใช้จ่ายมากสุด: ${top.map(([category, value]) => `${category} ${money(value)} บาท`).join(", ") || "ยังไม่มีข้อมูล"}\nงบประมาณที่ตั้งไว้:\n${budgetLines}`;
    const completion = await ai.chat.completions.create({
      model: process.env.OPENAI_MODEL,
      temperature: 0.4,
      max_tokens: 280, // เดิม 220 — เผื่อพื้นที่เพิ่มให้การขึ้นบรรทัดใหม่/bullet ตามกฎจัดรูปแบบใหม่ด้านล่าง ไม่ให้คำตอบถูกตัดกลางคัน
      // เดิมตั้ง 400 ซึ่งกว้างเกินคำตอบจริงมาก โมเดลบางตัว (โดยเฉพาะที่มี reasoning/thinking ในตัว) จะยิ่งใช้เวลาคิดนานขึ้นตาม budget ที่เปิดให้ — ลดค่านี้ช่วยตัดเวลาตอบโดยไม่ตัดคุณภาพคำตอบ เพราะคำตอบจริงไม่เคยยาวถึง 400 อยู่แล้ว
      messages: [
        { role: "system", content: "คุณคือ \"ยายจันทร์\" คุณยายที่ช่วยหลานดูแลเรื่องเงิน พูดกับผู้ใช้เหมือนยายคุยกับหลานตัวเองตามธรรมชาติ ไม่ใช่พนักงานหรือบอทที่พูดจาเป็นทางการ ใช้น้ำเสียงเป็นกันเอง อบอุ่น ตรงไปตรงมาแบบผู้ใหญ่ใจดี ห้ามลงท้ายประโยคด้วยคำว่า \"ครับ\" หรือ \"ค่ะ\"/\"คะ\" เด็ดขาด ให้พูดห้วนแบบยายคุยกับหลานแทน (เช่น พูดจบประโยคเฉย ๆ หรือใช้คำลงท้ายกันเองแบบ \"นะ\" \"นะเนี่ย\" \"เอาไหม\" \"เห็นไหม\" ได้บ้างแต่ไม่ต้องทุกประโยค) หลีกเลี่ยงศัพท์ทางการหรือภาษาเขียนแข็ง ๆ ให้เน้นให้คำปรึกษาและตอบคำถามด้านการเงินส่วนบุคคล (การออม การใช้จ่าย การตั้งงบประมาณ หนี้สิน หลักการลงทุนเบื้องต้น) โดยใช้ข้อมูลบัญชีของผู้ใช้ที่ให้มาประกอบการตอบเมื่อเกี่ยวข้อง คุณตอบคำถามทั่วไปอื่น ๆ นอกเรื่องการเงินได้เช่นกันแบบสั้นและเป็นมิตร แต่เมื่อมีโอกาสให้โยงกลับมาช่วยเรื่องการเงินอย่างเป็นธรรมชาติ กระชับ ไม่เกิน 4 ประโยค เหมาะสำหรับส่งทางแชท ห้ามให้คำแนะนำการลงทุนเฉพาะเจาะจงที่มีความเสี่ยงสูงหรือรับประกันผลตอบแทน และห้ามให้คำแนะนำทางกฎหมายหรือภาษีแบบฟันธง ให้แนะนำปรึกษาผู้เชี่ยวชาญแทนในกรณีนั้น จัดรูปแบบคำตอบให้อ่านง่ายบนมือถือเสมอ: ห้ามตอบเป็นย่อหน้ายาวติดกัน ให้ขึ้นบรรทัดใหม่ (\\n) แยกแต่ละประเด็นหรือแต่ละตัวเลขออกจากกัน ถ้ามีหลายรายการ/หลายหมวดให้จัดเป็นบรรทัดละรายการโดยขึ้นต้นด้วย \"• \" แทนการเขียนเรียงในประโยคเดียว ถ้ามีตัวเลขเงินให้แยกบรรทัดให้เด่นด้วย" },
        { role: "user", content: `${context}\n\nคำถามจากผู้ใช้: ${question}` }
      ]
    });
    return completion.choices[0]?.message?.content?.trim() || null;
  } catch (error) { console.warn("AI answer failed:", error.message); return null; }
}
async function downloadLineImage(messageId) {
  const r = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, { headers: { authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` } });
  if (!r.ok) throw new Error(`LINE content: ${r.status}`);
  const buffer = Buffer.from(await r.arrayBuffer());
  // สกรีนช็อตจากมือถือ (โดยเฉพาะแชทที่มีข้อความยาว ๆ ติดมาด้วย) มักมีความละเอียดสูงมาก (>1080x2400)
  // ส่ง base64 ตรง ๆ แบบเดิมทำให้ payload ใหญ่เกินกว่าที่บาง VLM engine (เช่น self-hosted NVIDIA NIM) จะรับไหว
  // ผลคือได้ 500 เปล่า ๆ แทนที่จะ reject อย่างสุภาพ — ย่อขนาดให้พอเหมาะกับงานอ่านตัวเลข/ตัวหนังสือก่อนเสมอ
  const resized = await sharp(buffer)
    .rotate() // เคารพ EXIF orientation ของภาพจากมือถือ
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  return { mime: "image/jpeg", base64: resized.toString("base64") };
}
// คืนค่า { receipt } ถ้าอ่านสำเร็จ, { error: "system" } ถ้า provider/AI พัง (ไม่เกี่ยวกับภาพ), { error: "unreadable" } ถ้าอ่านได้แต่ไม่เจอยอดเงินที่สมเหตุสมผล
// แยกสองเคสนี้ออกจากกัน เพราะข้อความที่ควรบอกผู้ใช้ต่างกันมาก — เดิมรวมเป็น null เดียวกันหมด ทำให้ปัญหาฝั่งระบบ (เช่น provider error 500)
// ถูกเข้าใจผิดว่าเป็นปัญหาความชัดของภาพ ทั้งที่ภาพชัดแค่ไหนก็อ่านไม่ได้เพราะ request ไปไม่ถึงขั้นตอนอ่านภาพเลยด้วยซ้ำ
async function readReceipt(mime, base64) {
  if (!ai || !visionModel) return { error: "system" };
  // ลองใหม่ได้ 1 ครั้งถ้าเจอ error 5xx (เช่น "EngineCore encountered an issue" จาก NVIDIA NIM) เพราะมักเป็นปัญหาชั่วคราวฝั่ง provider
  // ไม่ใช่ปัญหาภาพหรือโค้ดเรา — ถ้าลองใหม่แล้วยังพังอีก ถึงจะถือว่าเป็น error ฝั่งระบบจริง ๆ (ดู error handling ท้ายฟังก์ชัน)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const completion = await ai.chat.completions.create({
        model: visionModel,
        temperature: 0,
        max_tokens: 80, // เอาต์พุตเป็น JSON เล็ก ๆ แค่ {"merchant":"...","amount":number} เท่านั้น
        // ไม่ใส่ response_format: json_object เพราะ NVIDIA NIM VLM บางตัว (เช่น nemotron-nano-12b-v2-vl)
        // ตอบ 500 "EngineCore encountered an issue" เมื่อถูกบังคับ structured output แบบนี้ — คุม JSON ผ่าน prompt แทน
        messages: [
          { role: "system", content: "You read Thai/English receipt or bank-transfer slip photos. Reply with ONLY a raw JSON object, no markdown code fences, no explanation, in this exact shape: {\"merchant\":\"...\",\"amount\":number}. \"amount\" is the final total paid or transferred (บาท), as a plain number with no currency symbol or commas. If you cannot read a merchant/payee name, use \"อื่น ๆ\". If you cannot find a clear total amount, set amount to 0." },
          { role: "user", content: [
            { type: "text", text: "อ่านยอดรวมและชื่อร้านค้าจากใบเสร็จนี้" },
            { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } }
          ] }
        ]
      });
      const raw = completion.choices[0]?.message?.content ?? "{}";
      // บางโมเดล (โดยเฉพาะเมื่อไม่ได้บังคับ response_format) ยังห่อคำตอบด้วย ```json ... ``` ทั้งที่สั่งห้ามแล้ว — ตัดออกกันพังก่อน parse
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
      const parsed = JSON.parse(cleaned || "{}");
      const amount = Number(parsed.amount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) return { error: "unreadable" }; // โมเดลตอบสำเร็จ แต่ไม่เจอยอดเงินที่สมเหตุสมผลในภาพจริง ๆ
      const merchant = String(parsed.merchant ?? "อื่น ๆ").trim().slice(0, 120) || "อื่น ๆ";
      return { receipt: { merchant, amount } };
    } catch (error) {
      const status = error?.status ?? error?.response?.status;
      const isServerError = typeof status === "number" && status >= 500;
      console.warn(`Receipt AI read failed (attempt ${attempt + 1}/2, status=${status ?? "n/a"}):`, error.message);
      if (attempt === 0 && isServerError) continue; // ลองใหม่อีกครั้งเฉพาะ error 5xx (ฝั่ง provider พัง) ไม่ retry error อื่น เช่น 400 (รูปแบบ request ผิดเอง ลองใหม่ก็พังเหมือนเดิม)
      return { error: "system" }; // ทั้ง 5xx ที่ retry แล้วไม่หาย และ error อื่น ๆ (network, parse ผิดปกติ ฯลฯ) ถือเป็นปัญหาฝั่งระบบทั้งหมด ไม่ใช่ความผิดภาพ
    }
  }
}
function inLastDays(date, days) { const value = date instanceof Date ? date : new Date(date); return !Number.isNaN(value.getTime()) && Date.now() - value.getTime() <= days * 86_400_000; }
async function pushWeeklySummaries() {
  const snap = await usersCol.get();
  for (const doc of snap.docs) {
    const uid = doc.id, user = { ...emptyUser(), ...doc.data() };
    if (applyRecurring(user)) await saveUser(uid, user);
    const week = (user.transactions ?? []).filter((tx) => inLastDays(tx.createdAt, 7));
    if (!week.length) continue; // don't nag users with nothing to report
    try { await push(uid, `${summary(week, "สัปดาห์นี้")}\n\n${advice(week)}\n\nพิมพ์ “สรุปเดือนนี้” หรือ “เว็บ” เพื่อดูรายละเอียดเพิ่มเติมได้เลยนะ`); }
    catch (error) { console.warn(`Weekly push failed for ${uid}:`, error.message); }
  }
}
// Every Sunday at 20:00 (Asia/Bangkok). Change the cron expression or set WEEKLY_SUMMARY_CRON in .env to adjust.
cron.schedule(process.env.WEEKLY_SUMMARY_CRON ?? "0 20 * * 0", () => { pushWeeklySummaries().catch((error) => console.error("Weekly summary job failed:", error.message)); }, { timezone: "Asia/Bangkok" });

// เตือนจดประจำวัน — ผู้ใช้ตั้งเวลาเองต่อคน (user.reminderTime, HH:mm ตามเวลาไทย) จากหน้าตั้งค่าเว็บ
// รันทุกนาทีแล้วเทียบ "นาฬิกาไทยตอนนี้" กับเวลาที่แต่ละคนตั้งไว้ ไม่ใช่ cron ตายตัวแบบสรุปรายสัปดาห์
// เพราะผู้ใช้แต่ละคนเลือกเวลาต่างกันได้ — ตรวจ dailyReminder===true เท่านั้น และข้ามคนที่จดรายการวันนี้ไปแล้ว (ไม่กวนซ้ำ)
// หมายเหตุ: ถ้าเซิร์ฟเวอร์ sleep อยู่พอดีในนาทีนั้น (เช่น host แบบ free-tier ที่ sleep เมื่อไม่มี traffic)
// การเตือนของนาทีนั้นจะไม่ยิง และจะไม่ยิงย้อนหลังให้เมื่อเซิร์ฟเวอร์ตื่นขึ้นมาอีกครั้ง
function bangkokHHMM(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}
async function pushDailyReminders() {
  const nowHHMM = bangkokHHMM();
  const snap = await usersCol.get(); // กรองในหน่วยความจำแทน compound where ฝั่ง Firestore เพื่อไม่ต้องสร้าง composite index เพิ่ม (เข้าคู่กับ pushWeeklySummaries)
  for (const doc of snap.docs) {
    const uid = doc.id, user = { ...emptyUser(), ...doc.data() };
    if (!user.dailyReminder || (user.reminderTime ?? "20:00") !== nowHHMM) continue;
    if ((user.transactions ?? []).some((tx) => sameDay(tx.createdAt))) continue; // จดวันนี้ไปแล้ว ไม่ต้องเตือนซ้ำ
    const premium = await subscriptionService.isPremium(uid).catch(() => false);
    if (!premium) continue; // เตือนจดประจำวันเป็นฟีเจอร์ Premium — เผื่อสมัครหมดอายุไปแล้วแต่ค่ายังเปิดค้างอยู่ในโปรไฟล์
    try { await push(uid, "🔔 อย่าลืมจดรายรับรายจ่ายวันนี้นะคะ พิมพ์ เช่น “ค่าอาหาร 80” หรือ “เงินเดือน 15000” ได้เลย"); }
    catch (error) { console.warn(`Daily reminder push failed for ${uid}:`, error.message); }
  }
}
cron.schedule("* * * * *", () => { pushDailyReminders().catch((error) => console.error("Daily reminder job failed:", error.message)); }, { timezone: "Asia/Bangkok" });

const dashboard = await fs.readFile(path.join(__dirname, "dashboard.html"), "utf8");
const confirmMessagePage = await fs.readFile(path.join(__dirname, "confirm-message.html"), "utf8");
const proPage = await fs.readFile(path.join(__dirname, "pro.html"), "utf8");

app.get("/health", (_req, res) => res.json({ ok: true, app: "pa-nuan" }));

// หน้าคั่นก่อนเข้าแดชบอร์ด (interstitial) — ผู้ใช้ทั่วไปต้อง "ดูโฆษณา" ก่อนเข้าทุกครั้ง
// Premium ข้ามไปที่ /dashboard ตรงเลย ไม่ต้องผ่านหน้านี้
// หมายเหตุ: ช่อง #ad-slot เป็น placeholder เท่านั้น — ยังไม่ได้ต่อ ad network จริง (เช่น AdSense/Adsterra)
// ให้ใส่สคริปต์ของ network ที่เลือกไว้ในคอมเมนต์ที่ระบุไว้ด้านล่างทีหลัง
function adInterstitial({ nextUrl, waitSeconds }) {
  return String.raw`<!doctype html>
<html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>กำลังเข้าสู่แดชบอร์ด | ยายจันทร์</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#0f0e12;color:#fff;font-family:system-ui,-apple-system,"Noto Sans Thai",sans-serif;min-height:100vh;display:flex;flex-direction:column}
.wrap{max-width:440px;margin:0 auto;width:100%;min-height:100vh;display:flex;flex-direction:column}
.top{padding:16px 20px;display:flex;justify-content:space-between;align-items:center;color:#a09aa8;font-size:13px}
.ad-slot{flex:1;margin:0 16px;border-radius:16px;background:linear-gradient(135deg,#25202c,#1a1720);border:1px dashed #43394f;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;min-height:320px}
.ad-slot b{font-size:15px;color:#c9a0d8}.ad-slot span{font-size:12px;color:#6f6878}
.timer{text-align:center;padding:18px 20px 8px;font-size:13px;color:#a09aa8}
.actions{padding:16px 20px 28px;display:flex;flex-direction:column;gap:10px}
button{border:0;border-radius:12px;padding:14px;font:inherit;font-weight:700;font-size:15px}
.skip{background:#2a2531;color:#5f5769}.skip.ready{background:#3a3244;color:#fff}
.premium{background:linear-gradient(135deg,#D23283,#C79A46);color:#fff}
</style><body><div class="wrap">
<div class="top"><span>ยายจันทร์ 📒</span><span>โฆษณา</span></div>
<div class="ad-slot" id="adSlot"><b>พื้นที่โฆษณา</b><span>ตรงนี้จะแสดงโฆษณาจริงเมื่อเปิดใช้งาน</span></div>
<!-- TODO: ใส่สคริปต์ ad network จริงตรงนี้ (เช่น Google AdSense/Adsterra rewarded unit) แล้วยิง event ตอนดูจบไปแทนที่ setTimeout ด้านล่าง -->
<div class="timer" id="timer">รอ ${waitSeconds} วินาที เพื่อข้ามโฆษณา…</div>
<div class="actions">
<button class="skip" id="skipBtn" disabled>ข้ามโฆษณา</button>
<button class="premium" id="premiumBtn">สมัคร Premium เพื่อข้ามโฆษณาตลอดไป</button>
</div>
</div>
<script>
let remaining = ${waitSeconds};
const timerEl = document.getElementById('timer'), skipBtn = document.getElementById('skipBtn');
const tick = () => {
  remaining -= 1;
  if (remaining <= 0) {
    timerEl.textContent = 'ข้ามได้แล้ว';
    skipBtn.disabled = false; skipBtn.classList.add('ready');
    clearInterval(interval);
  } else {
    timerEl.textContent = 'รอ ' + remaining + ' วินาที เพื่อข้ามโฆษณา…';
  }
};
const interval = setInterval(tick, 1000);
skipBtn.onclick = () => { if (!skipBtn.disabled) location.href = ${JSON.stringify(nextUrl)}; };
document.getElementById('premiumBtn').onclick = () => { window.close(); };
</script>
</body></html>`;
}
app.get("/dashboard-gate", async (req, res) => {
  if (!allowed(req)) return res.sendStatus(401);
  const uid = req.query.u;
  const query = `?token=${encodeURIComponent(req.query.token)}&u=${encodeURIComponent(uid)}`;
  // uid อาจเป็นบัญชีส่วนตัว (userId) หรือกลุ่ม/ห้อง (groupId/roomId) — isPremium เช็คได้เฉพาะบัญชีส่วนตัว
  // ถ้าไม่ใช่ Premium ส่วนตัว ต้องเช็คต่อว่าเป็นกลุ่มที่ปลดล็อก Premium ไว้แล้วหรือเปล่า (เจ้าของกลุ่มเป็น Premium + ยืนยันแล้ว)
  // ไม่งั้นสมาชิกกลุ่ม Premium ทุกคนจะโดนโฆษณาอยู่ดีทั้งที่กลุ่มปลดล็อกแล้ว
  const premium = (await subscriptionService.isPremium(uid).catch(() => false)) || (await groupLinkService.isPremiumGroup(uid).catch(() => false));
  if (premium) return res.redirect(`/dashboard${query}`);
  const waitSeconds = Number(process.env.DASHBOARD_AD_WAIT_SECONDS) || 25;
  res.type("html").send(adInterstitial({ nextUrl: `/dashboard${query}`, waitSeconds }));
});
app.get("/dashboard", (req, res) => allowed(req) ? res.type("html").send(dashboard) : res.sendStatus(401));
app.get("/confirm-message", (req, res) => allowed(req) ? res.type("html").send(confirmMessagePage) : res.sendStatus(401));
app.get("/pro", (req, res) => allowed(req) ? res.type("html").send(proPage) : res.sendStatus(401));
function transactionInput(body) {
  const type = body?.type === "income" ? "income" : body?.type === "expense" ? "expense" : null;
  const description = String(body?.description ?? "").trim().slice(0, 120);
  const category = String(body?.category ?? "").trim().slice(0, 60);
  const amount = Number(body?.amount);
  const date = new Date(body?.createdAt);
  if (!type || !description || !category || !Number.isFinite(amount) || amount <= 0 || amount > 10_000_000 || Number.isNaN(date.getTime())) return null;
  return { type, description, category, amount, createdAt: date.toISOString() };
}
function recurringInput(body) {
  const type = body?.type === "income" ? "income" : body?.type === "expense" ? "expense" : null;
  const description = String(body?.description ?? "").trim().slice(0, 120), category = String(body?.category ?? "").trim().slice(0, 60), amount = Number(body?.amount), day = Number(body?.day);
  if (!type || !description || !category || !Number.isFinite(amount) || amount <= 0 || amount > 10_000_000 || !Number.isInteger(day) || day < 1 || day > 31) return null;
  return { type, description, category, amount, day };
}
// HH:mm ตามเวลาไทย เช่น "20:00" — ผู้ใช้ตั้งเองในหน้าตั้งค่า
function reminderInput(body) {
  const enabled = Boolean(body?.enabled);
  const time = String(body?.time ?? "20:00").trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  return { dailyReminder: enabled, reminderTime: time };
}
// ตั้งค่าการ์ด "จดสำเร็จ" (ดู txFlexMessage/CONFIRM_MESSAGE_THEMES ด้านบน) — ฟีเจอร์ Premium เฉพาะแชทกลุ่ม
function confirmMessagePrefsInput(body) {
  if (typeof body?.theme !== "undefined" && !(body.theme in CONFIRM_MESSAGE_THEMES)) return null;
  return {
    showBudgetBar: Boolean(body?.showBudgetBar),
    showAuthorName: Boolean(body?.showAuthorName),
    showEditButton: Boolean(body?.showEditButton),
    showDeleteButton: Boolean(body?.showDeleteButton),
    theme: body?.theme in CONFIRM_MESSAGE_THEMES ? body.theme : "pink"
  };
}
function applyRecurring(user) {
  user.recurring ??= [];
  const now = new Date(), key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  let changed = false;
  for (const recurring of user.recurring) {
    if (recurring.lastApplied === key) continue;
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(), date = new Date(now.getFullYear(), now.getMonth(), Math.min(recurring.day, lastDay), 12);
    if (date > now) continue;
    user.transactions.push({ id: crypto.randomUUID(), type: recurring.type, description: recurring.description, category: recurring.category, amount: recurring.amount, createdAt: date.toISOString(), recurringId: recurring.id });
    recurring.lastApplied = key; changed = true;
  }
  return changed;
}
app.get("/api/transactions", async (req, res) => {
  if (!allowed(req)) return res.sendStatus(401);
  const uid = req.query.u, user = await getUser(uid), now = new Date();
  if (applyRecurring(user)) await saveUser(uid, user);
  res.json({ label: new Intl.DateTimeFormat("th-TH", { month: "long", year: "numeric", timeZone: "Asia/Bangkok" }).format(now), transactions: [...user.transactions].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
});
app.get("/api/recurring", async (req, res) => {
  if (!allowed(req)) return res.sendStatus(401);
  const user = await getUser(req.query.u); res.json({ recurring: user.recurring ?? [] });
});
app.get("/api/budgets", async (req, res) => {
  if (!allowed(req)) return res.sendStatus(401);
  const user = await getUser(req.query.u); res.json({ budgets: user.budgets ?? {} });
});
app.put("/api/budgets/:category", express.json(), async (req, res) => {
  if (!allowed(req)) return res.sendStatus(401);
  const category = String(req.params.category ?? "").trim().slice(0, 60), amount = Number(req.body?.amount);
  if (!category || !Number.isFinite(amount) || amount < 0 || amount > 10_000_000) return res.status(400).json({ error: "ข้อมูลงบประมาณไม่ถูกต้อง" });
  const uid = req.query.u, user = await getUser(uid); user.budgets ??= {}; user.budgets[category] = amount;
  await saveUser(uid, user); res.json({ category, amount });
});
// เตือนจดประจำวัน: ผู้ใช้ตั้งเปิด/ปิด และเวลาที่ต้องการเอง (HH:mm ตามเวลาไทย) — cron ทุกนาทีจะเช็คและ push ให้ (ดู pushDailyReminders)
app.get("/api/reminder", async (req, res) => {
  if (!allowed(req)) return res.sendStatus(401);
  const user = await getUser(req.query.u);
  res.json({ dailyReminder: Boolean(user.dailyReminder), reminderTime: user.reminderTime ?? "20:00" });
});
app.put("/api/reminder", express.json(), async (req, res) => {
  if (!allowed(req)) return res.sendStatus(401);
  const input = reminderInput(req.body); if (!input) return res.status(400).json({ error: "เวลาที่ตั้งไม่ถูกต้อง" });
  const uid = req.query.u, user = await getUser(uid);
  // ฟีเจอร์ Premium: ผู้ใช้ฟรีเปิดใช้งานไม่ได้ (แต่ปิดได้เสมอ เผื่อเคยเปิดไว้ตอนยังเป็น Premium แล้วหมดอายุ)
  if (input.dailyReminder) {
    const premium = await subscriptionService.isPremium(uid).catch(() => false);
    if (!premium) return res.status(403).json({ error: "เตือนจดประจำวันเป็นฟีเจอร์ของสมาชิก Premium" });
  }
  user.dailyReminder = input.dailyReminder; user.reminderTime = input.reminderTime;
  await saveUser(uid, user); res.json(input);
});
// ปรับแต่งการ์ด "จดสำเร็จ" (แถบงบ/ชื่อผู้จด/ปุ่มแก้ไข/ปุ่มลบ/ธีมสี) — ฟีเจอร์ Premium ใช้ได้ทั้งแชทกลุ่มและแชทส่วนตัว 1:1
// (เดิมจำกัดแค่กลุ่มเพราะคิดว่าแชทส่วนตัวมีแค่เจ้าของคนเดียวเห็นการ์ด เลยไม่มีประโยชน์ — แต่ผู้ใช้ 1:1 ก็อยากปรับธีม/ซ่อนปุ่มเองได้เหมือนกัน
// ส่วน "ชื่อผู้จด" (showAuthorName) ไม่มีความหมายใน 1:1 เพราะมีคนจดคนเดียวอยู่แล้ว — คุมที่ฝั่ง UI (confirm-message.html) ไม่ต้องคุมที่ backend)
// isGroup ในผลลัพธ์ยังส่งกลับไปเผื่อ UI อยากรู้ (เช่น จะซ่อนตัวเลือก "ชื่อผู้จด" ถ้าไม่ใช่กลุ่ม)
async function resolveConfirmMessageAuth(uid) {
  const groupLink = await groupLinkService.getRaw(uid).catch(() => null);
  if (groupLink) {
    // Premium ผูกกับ ownerId ของกลุ่ม ไม่ใช่ groupId เอง (เหมือน /api/subscription และ /dashboard-gate ด้านบน)
    const premium = await groupLinkService.isPremiumGroup(uid).catch(() => false);
    return { isGroup: true, premium };
  }
  const premium = await subscriptionService.isPremium(uid).catch(() => false);
  return { isGroup: false, premium };
}
app.get("/api/confirm-message-prefs", async (req, res) => {
  if (!allowed(req)) return res.sendStatus(401);
  const uid = req.query.u;
  const { isGroup } = await resolveConfirmMessageAuth(uid);
  const user = await getUser(uid);
  res.json({ ...defaultConfirmMessagePrefs(), ...(user.confirmMessagePrefs ?? {}), isGroup });
});
app.put("/api/confirm-message-prefs", express.json(), async (req, res) => {
  if (!allowed(req)) return res.sendStatus(401);
  const uid = req.query.u;
  const { isGroup, premium } = await resolveConfirmMessageAuth(uid);
  if (!premium) return res.status(403).json({ error: "ตั้งค่าข้อความยืนยันเป็นฟีเจอร์ของสมาชิก Premium" });
  const input = confirmMessagePrefsInput(req.body); if (!input) return res.status(400).json({ error: "ข้อมูลไม่ถูกต้อง" });
  const user = await getUser(uid); user.confirmMessagePrefs = input;
  await saveUser(uid, user); res.json({ ...input, isGroup });
});
app.post("/api/recurring", express.json(), async (req, res) => {
  if (!allowed(req)) return res.sendStatus(401);
  const input = recurringInput(req.body); if (!input) return res.status(400).json({ error: "ข้อมูลรายการประจำไม่ถูกต้อง" });
  const uid = req.query.u, user = await getUser(uid), recurring = { id: crypto.randomUUID(), ...input }; user.recurring ??= []; user.recurring.push(recurring); await saveUser(uid, user); res.status(201).json({ recurring });
});
app.delete("/api/recurring/:id", async (req, res) => {
  if (!allowed(req)) return res.sendStatus(401);
  const uid = req.query.u, user = await getUser(uid); user.recurring ??= []; const index = user.recurring.findIndex((item) => item.id === req.params.id);
  if (index < 0) return res.sendStatus(404);
  const [recurring] = user.recurring.splice(index, 1); await saveUser(uid, user); res.json({ recurring });
});
app.post("/api/transactions", express.json(), async (req, res) => {
  if (!allowed(req)) return res.sendStatus(401);
  const input = transactionInput(req.body);
  if (!input) return res.status(400).json({ error: "ข้อมูลรายการไม่ถูกต้อง" });
  const uid = req.query.u, user = await getUser(uid), transaction = { id: crypto.randomUUID(), ...input };
  user.transactions.push(transaction); await saveUser(uid, user); res.status(201).json({ transaction });
});
app.put("/api/transactions/:id", express.json(), async (req, res) => {
  if (!allowed(req)) return res.sendStatus(401);
  const input = transactionInput(req.body), uid = req.query.u, user = await getUser(uid), index = user.transactions.findIndex((tx) => tx.id === req.params.id);
  if (!input) return res.status(400).json({ error: "ข้อมูลรายการไม่ถูกต้อง" });
  if (index < 0) return res.sendStatus(404);
  const transaction = { ...user.transactions[index], ...input }; user.transactions[index] = transaction;
  await saveUser(uid, user); res.json({ transaction });
});
app.delete("/api/transactions/:id", async (req, res) => {
  if (!allowed(req)) return res.sendStatus(401);
  const uid = req.query.u, user = await getUser(uid), index = user.transactions.findIndex((tx) => tx.id === req.params.id);
  if (index < 0) return res.sendStatus(404);
  const [transaction] = user.transactions.splice(index, 1); await saveUser(uid, user); res.json({ transaction });
});
app.get("/api/transactions/export", async (req, res) => {
  if (!allowed(req)) return res.sendStatus(401);
  const user = await getUser(req.query.u), quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const csv = ["วันที่,ประเภท,รายการ,หมวดหมู่,จำนวนเงิน", ...user.transactions.map((tx) => [new Date(tx.createdAt).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }), tx.type === "income" ? "รายรับ" : "รายจ่าย", tx.description, tx.category, tx.amount].map(quote).join(","))].join("\n");
  res.set({ "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=pa-nuan-transactions.csv" }).send(`\uFEFF${csv}`);
});
// รายงาน PDF สรุปรายเดือน/รายปี — ฟีเจอร์ Premium เท่านั้น (ต่างจาก CSV export ด้านบนที่ใช้ได้ทุกคน)
// ต้องเช็คสิทธิ์ Premium แบบเดียวกับ /api/subscription ด้านล่าง (รองรับทั้ง userId เดี่ยวและ groupId ที่ผูกกับ ownerId)
// query params: period=month|year (default month), year=YYYY (default ปีปัจจุบัน), month=1-12 (จำเป็นถ้า period=month, default เดือนปัจจุบัน)
app.get("/api/reports/pdf", async (req, res) => {
  if (!allowed(req)) return res.sendStatus(401);
  const uid = req.query.u;
  const groupLink = await groupLinkService.getRaw(uid).catch(() => null);
  const statusUid = groupLink?.ownerId ?? uid;
  const isPremium = await subscriptionService.isPremium(statusUid).catch(() => false);
  if (!isPremium) return res.status(403).json({ error: "premium_required", message: "รายงาน PDF เป็นฟีเจอร์ Premium" });

  const period = req.query.period === "year" ? "year" : "month";
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = period === "month" ? (Number(req.query.month) || now.getMonth() + 1) : undefined;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return res.status(400).json({ error: "invalid_year" });
  if (period === "month" && (!Number.isInteger(month) || month < 1 || month > 12)) return res.status(400).json({ error: "invalid_month" });

  const user = await getUser(uid);
  const inRange = (tx) => {
    const d = new Date(tx.createdAt);
    if (Number.isNaN(d.getTime())) return false;
    return period === "year" ? d.getFullYear() === year : (d.getFullYear() === year && d.getMonth() + 1 === month);
  };
  const transactions = (user.transactions ?? []).filter(inRange);
  const isGroupChat = Boolean(groupLink);
  const ownerLabel = isGroupChat ? "กองกลางของกลุ่ม" : null; // ไม่ดึงชื่อผู้ใช้จริงมาโชว์ในรายงาน กันข้อมูลส่วนตัวรั่วถ้าไฟล์ถูกส่งต่อ

  try {
    const pdfBuffer = await generateReportPdf({ period, year, month, transactions, budgets: user.budgets ?? {}, ownerLabel });
    const filename = period === "year" ? `pa-nuan-report-${year}.pdf` : `pa-nuan-report-${year}-${String(month).padStart(2, "0")}.pdf`;
    res.set({ "content-type": "application/pdf", "content-disposition": `attachment; filename=${filename}` }).send(pdfBuffer);
  } catch (error) {
    console.error("PDF report generation failed:", error.message);
    // ข้อความ error นี้อาจมาจาก assertFontsReady() (ยังไม่ได้วางไฟล์ฟอนต์) หรือ pdfkit ล้มเหลวด้วยเหตุอื่น — log เต็มไว้ฝั่งเซิร์ฟเวอร์
    // แต่ตอบกลับ client แบบสั้น ๆ พอ ไม่ควรโชว์ path ไฟล์ภายในเซิร์ฟเวอร์ให้ client เห็นตรง ๆ
    res.status(500).json({ error: "pdf_generation_failed", message: "สร้างรายงาน PDF ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" });
  }
});
// สถานะสมาชิก Premium จริงจาก DB (ไม่เชื่อ client) — ใช้แสดงในหน้าตั้งค่าของ dashboard.html
app.get("/api/subscription", async (req, res) => {
  if (!allowed(req)) return res.sendStatus(401);
  const uid = req.query.u;
  // เดิมเช็คแค่ subscriptionService.getStatusView(uid) ทางเดียว ถ้า uid เป็น groupId (ไม่ใช่ userId ของคนจ่ายเงิน)
  // จะหา subscription doc ด้วย groupId ซึ่งไม่มีทางเจอ (Premium ผูกกับ ownerId ของกลุ่ม ไม่ใช่ groupId เอง)
  // -> fallback เป็น FREE เสมอ แม้เจ้าของกลุ่มจะเป็น Premium จริงก็ตาม (จุดเดียวกับที่ /dashboard บรรทัด ~822 เช็คถูกอยู่แล้ว
  // ผ่าน groupLinkService.isPremiumGroup แต่ endpoint นี้ลืมเช็คทางกลุ่มไปจุดเดียว ทำให้เข้าหน้าเว็บได้แต่ปุ่ม Premium กดไม่ติด)
  const groupLink = await groupLinkService.getRaw(uid).catch(() => null);
  const statusUid = groupLink?.ownerId ?? uid;
  const status = await subscriptionService.getStatusView(statusUid).catch(() => ({ plan: PLAN.FREE, active: false }));
  const lineOaLink = process.env.LINE_OA_BASIC_ID ? `https://line.me/R/ti/p/${encodeURIComponent(process.env.LINE_OA_BASIC_ID)}` : null;
  // isGroup: ให้หน้าเว็บรู้ว่า u นี้คือแชทกลุ่มไหม เพื่อโชว์/ซ่อนเมนู "ข้อความยืนยัน" (ฟีเจอร์เฉพาะกลุ่ม ดู /api/confirm-message-prefs)
  res.json({ ...status, lineOaLink, isGroup: Boolean(groupLink) });
});
// สมัคร/ต่ออายุ Premium จากหน้าเว็บ — ใช้ paymentSessionService + qrService ตัวเดียวกับที่ฝั่ง LINE ใช้
// (ดู lineHandlers.js handleSubscribeCommand) เพื่อให้ session/QR ผูกกับ user เดียวกันไม่ว่าจะสมัครทางไหน
app.post("/api/premium/checkout", express.json(), async (req, res) => {
  if (!allowed(req)) return res.sendStatus(401);
  const uid = req.query.u;
  // planKey มาจาก body เท่านั้น (ไม่ใช่ amount ตรง ๆ) แล้วให้ paymentSessionService แปลงเป็นราคา/ระยะเวลาเอง
  // เพื่อไม่ให้ client กำหนดยอดเงินได้เอง — createOrReuse จะ fallback เป็น MONTHLY ถ้าค่าที่ส่งมาไม่รู้จัก
  const requestedPlan = req.body?.plan === "YEARLY" ? "YEARLY" : "MONTHLY";
  const status = await subscriptionService.getStatusView(uid).catch(() => ({ plan: PLAN.FREE, active: false }));
  if (status.active) return res.json({ alreadyPremium: true, expiresAt: status.expiresAt });
  const { session } = await paymentSessionService.createOrReuse(uid, requestedPlan);
  const qr = qrService.generateForSession(session);
  if (!qr.available) return res.status(503).json({ error: "ยังไม่พร้อมรับชำระเงิน กรุณาติดต่อผู้ดูแลระบบ", note: qr.note });
  res.json({
    sessionId: session.id,
    referenceId: session.referenceId,
    plan: session.plan ?? requestedPlan,
    months: session.months ?? (requestedPlan === "YEARLY" ? 12 : 1),
    amount: session.amount,
    expiresAt: session.expiresAt,
    qrImageUrl: `/qr/${session.id}.png`
  });
});
// รับสลิป (base64) จากหน้าเว็บ แล้ววิ่งผ่าน OCR + verify path เดียวกับฝั่ง LINE (paymentTransactionService.submitAndVerify)
// จำกัดขนาด body ไว้ที่ 8mb พอสำหรับรูปสลิปถ่ายจากมือถือ (ไม่ใช้ multer เพราะ client ส่งเป็น JSON base64 ตรงไปตรงมา)
app.post("/api/premium/slip", express.json({ limit: "8mb" }), async (req, res) => {
  if (!allowed(req)) return res.sendStatus(401);
  const uid = req.query.u;
  const { sessionId, mime, base64 } = req.body ?? {};
  if (!sessionId || !mime || !base64) return res.status(400).json({ error: "ข้อมูลสลิปไม่ครบ" });
  if (!/^image\/(png|jpe?g|webp)$/i.test(mime)) return res.status(400).json({ error: "รองรับเฉพาะไฟล์รูปภาพ (jpg/png/webp)" });

  const validation = await paymentSessionService.validateForUpload(sessionId, uid);
  if (!validation.ok) {
    const reasonMsg = {
      EXPIRED: "รายการชำระเงินหมดอายุแล้ว กรุณากดสมัครใหม่อีกครั้ง",
      USER_MISMATCH: "ไม่พบรายการชำระเงินนี้สำหรับบัญชีของคุณ",
      ALREADY_CONSUMED: "รายการนี้ถูกใช้ไปแล้ว กรุณากดสมัครใหม่หากต้องการสมัครอีกครั้ง",
      NOT_FOUND: "ไม่พบรายการชำระเงิน กรุณากดสมัครใหม่อีกครั้ง"
    }[validation.reason] ?? "ไม่พบรายการชำระเงิน กรุณากดสมัครใหม่อีกครั้ง";
    return res.status(409).json({ error: reasonMsg, reason: validation.reason });
  }

  let ocrData = null;
  try {
    ocrData = await readSlip(ai, visionModel, mime, base64);
  } catch (error) {
    console.error("Web slip OCR failed:", error.message);
    return res.status(502).json({ error: "ระบบประมวลผลภาพใช้เวลานานกว่าปกติ กรุณาลองใหม่อีกครั้ง" });
  }
  if (!ocrData) return res.status(422).json({ error: "อ่านข้อมูลจากสลิปนี้ไม่ได้ ลองถ่ายให้เห็นยอดเงินและเลขอ้างอิงชัด ๆ อีกครั้ง" });

  const result = await paymentTransactionService.submitAndVerify({ userId: uid, paymentSession: validation.session, ocrData });
  await paymentSessionService.consume(validation.session.id);
  if (result.outcome === TX_STATUS.VERIFIED) await richMenuService.switchTo(uid, "PREMIUM").catch(() => {});

  const messages = {
    [TX_STATUS.VERIFIED]: "ชำระเงินสำเร็จ 🎉 ตอนนี้คุณเป็นสมาชิก Premium แล้ว",
    [TX_STATUS.PENDING_REVIEW]: "ได้รับสลิปแล้ว ระบบกำลังตรวจสอบเพิ่มเติม เจ้าหน้าที่จะยืนยันให้เร็วที่สุด กรุณารอการแจ้งเตือนอีกครั้ง 🙏",
    [TX_STATUS.REJECTED]: "ไม่สามารถยืนยันการชำระเงินได้ กรุณาตรวจสอบสลิปและลองใหม่อีกครั้ง",
    [TX_STATUS.DUPLICATE]: "สลิปนี้ถูกใช้งานไปแล้ว"
  };
  res.json({ outcome: result.outcome, message: messages[result.outcome] ?? messages[TX_STATUS.REJECTED] });
});
app.get("/api/dashboard", async (req, res) => {
  if (!allowed(req)) return res.sendStatus(401);
  const user = await getUser(req.query.u), current = user.transactions.filter((tx) => sameMonth(tx.createdAt)), t = totals(current);
  const categories = Object.entries(current.filter((tx) => tx.type === "expense").reduce((o, tx) => ({ ...o, [tx.category]: (o[tx.category] ?? 0) + tx.amount }), {})).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);
  const now = new Date(), history = Array.from({ length: 6 }, (_, index) => { const d = new Date(now.getFullYear(), now.getMonth() - (5 - index), 1), p = parts(d), total = totals(user.transactions.filter((tx) => sameMonth(tx.createdAt, p.year, p.month))); return { label: new Intl.DateTimeFormat("th-TH", { month: "short", timeZone: "Asia/Bangkok" }).format(d), ...total }; });
  res.json({ label: `ข้อมูลเดือน ${new Intl.DateTimeFormat("th-TH", { month: "long", year: "numeric", timeZone: "Asia/Bangkok" }).format(now)}`, income: t.income, expense: t.expense, balance: t.income - t.expense, categories, history, recent: [...user.transactions].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map((tx) => ({ ...tx, date: new Intl.DateTimeFormat("th-TH", { dateStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(tx.createdAt)) })) });
});
// เรนเดอร์ QR ของ payment session เป็นภาพ PNG จริง เพื่อให้ LINE Image Message ใช้ originalContentUrl/
// previewImageUrl ชี้มาที่นี่ได้ (LINE ต้องการ URL รูปภาพที่เข้าถึงได้จริง จะส่ง payload string ตรง ๆ ไม่ได้)
app.get("/qr/:sessionId.png", async (req, res) => {
  try {
    const session = await paymentSessionService.getById(req.params.sessionId);
    if (!session) return res.sendStatus(404);
    const qr = qrService.generateForSession(session);
    if (!qr.available) return res.sendStatus(404);
    res.set({ "content-type": "image/png", "cache-control": "no-store" });
    await QRCode.toFileStream(res, qr.payload, { type: "png", width: 500, margin: 2 });
  } catch (error) {
    console.error("QR image render failed:", error.message);
    res.sendStatus(500);
  }
});
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!signatureValid(req.body, req.get("x-line-signature"))) return res.sendStatus(401);
  res.sendStatus(200); const payload = JSON.parse(req.body.toString("utf8"));
  for (const event of payload.events ?? []) {
    // --- ผู้ใช้แอดบอทเป็นเพื่อนใหม่ (1-1 chat) — คนละ event กับ "join" (นั่นคือถูกเชิญเข้ากลุ่ม/ห้อง ดูด้านล่าง) ---
    if (event.type === "follow") {
      const uid = event.source?.userId;
      if (!uid) continue;
      try { await replyMessages(event.replyToken, [followWelcomeFlexMessage()]); }
      catch (error) { console.error("Follow welcome message failed:", error.message); }
      continue;
    }
    // --- บอทถูกเชิญเข้ากลุ่ม/ห้อง: เริ่มรอยืนยันเจ้าของ (spec: กลุ่มจดบัญชี) ---
    if (event.type === "join") {
      const groupId = event.source?.groupId ?? event.source?.roomId;
      if (!groupId) continue;
      try {
        await groupLinkService.startPending(groupId);
        await replyMessages(event.replyToken, [groupWelcomeFlexMessage()]);
      } catch (error) { console.error("Group join handling failed:", error.message); }
      continue;
    }
    // --- บอทถูกเตะ/ออกจากกลุ่มเอง: เคลียร์สถานะ link ทิ้ง ---
    if (event.type === "leave") {
      const groupId = event.source?.groupId ?? event.source?.roomId;
      if (!groupId) continue;
      try { await groupLinkService.removeLink(groupId); } catch (error) { console.error("Group leave cleanup failed:", error.message); }
      continue;
    }
    // --- ปุ่ม "รายรับ/รายจ่าย" หลังอ่านสลิป (ดู receiptConfirmFlexMessage) — ยังไม่เคยบันทึก tx จริงจนกว่าจะถึงตรงนี้ ---
    if (event.type === "postback") {
      const data = event.postback?.data ?? "";
      const params = new URLSearchParams(data);
      // --- ปุ่ม "ลบ" บนการ์ดจดสำเร็จ (ดู txFlexMessage) — ลบรายการทันที ไม่ถามยืนยันซ้ำ ---
      if (params.has("delete_tx")) {
        const txId = params.get("delete_tx");
        const delUserId = params.get("u");
        let message;
        if (!txId || !delUserId) message = noticeFlexMessage("ข้อมูลรายการหมดอายุแล้ว", "info");
        else {
          try {
            const user = await getUser(delUserId);
            const index = (user.transactions ?? []).findIndex((t) => t.id === txId);
            if (index === -1) message = noticeFlexMessage("ไม่พบรายการนี้แล้ว อาจถูกลบไปก่อนหน้านี้", "info");
            else {
              const [removed] = user.transactions.splice(index, 1);
              await saveUser(delUserId, user);
              message = noticeFlexMessage(`ลบแล้ว: ${removed.description} ${money(removed.amount)} บาท`, "success");
            }
          } catch (error) { console.error("Delete tx postback failed", error.message); message = noticeFlexMessage("เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง", "error"); }
        }
        try { await replyMessages(event.replyToken, [message]); } catch (error) { console.error("Could not reply", error.message); }
        continue;
      }
      if (params.get("slip_type") === "income" || params.get("slip_type") === "expense") {
        const pbSourceType = event.source?.type;
        const pbIsGroupChat = pbSourceType === "group" || pbSourceType === "room";
        const pbUserId = pbIsGroupChat ? (event.source?.groupId ?? event.source?.roomId) : event.source?.userId;
        if (!pbUserId) continue;
        let message;
        try {
          const type = params.get("slip_type");
          const step = params.get("slip_step") ?? "save"; // เดิมไม่มี step, บันทึกทันที — เผื่อ postback เก่าที่ยังไม่มี slip_step ค้างอยู่ในมือถือผู้ใช้ ให้ default เป็น "save" (พฤติกรรมเดิม)
          const merchant = decodeURIComponent(params.get("m") ?? "อื่น ๆ").slice(0, 120) || "อื่น ๆ";
          const amount = Number(params.get("a"));
          const authorId = params.get("aid") ?? event.source?.userId ?? null;
          if (!Number.isFinite(amount) || amount <= 0) message = "ข้อมูลสลิปหมดอายุแล้ว ลองส่งรูปใหม่อีกครั้ง";
          else if (step === "category") {
            // ปุ่ม "รายจ่าย" ถูกกด -> ยังไม่บันทึก แสดงการ์ดเลือกหมวดหมู่ต่อก่อน (ดู categoryPickerFlexMessage)
            message = categoryPickerFlexMessage(merchant, amount, { authorId });
          } else {
            const category = decodeURIComponent(params.get("c") ?? ""); // ว่างได้ถ้ากด "ให้ยายเลือกให้" หรือเป็นรายรับ (ไม่มี c เลย)
            const { user, tx } = await saveConfirmedSlipTx({ userId: pbUserId, type, merchant, amount, category, authorId, isGroupChat: pbIsGroupChat });
            // confirmMessagePrefs ใช้ได้ทั้งกลุ่มและแชทส่วนตัว (ฟีเจอร์ Premium) — ผู้ใช้ที่ไม่เคยตั้งค่าจะได้ default เดิมอยู่แล้ว (ดู defaultConfirmMessagePrefs)
            message = txFlexMessage(tx, { budget: budgetProgressFor(user, tx), dashboardUrl: dashboardEditUrl(pbUserId), userId: pbUserId, prefs: user.confirmMessagePrefs });
          }
        } catch (error) { console.error("Slip postback confirm failed", error.message); message = "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง"; }
        try { await (typeof message === "string" ? reply(event.replyToken, message) : replyMessages(event.replyToken, [message])); } catch (error) { console.error("Could not reply", error.message); }
      }
      continue;
    }
    if (event.type !== "message") continue;
    const sourceType = event.source?.type; // "user" | "group" | "room"
    const isGroupChat = sourceType === "group" || sourceType === "room";
    // ในกลุ่ม/ห้อง: รายการทั้งหมดเข้ากองกลางเดียวกันที่คีย์ด้วย groupId/roomId
    // ผู้จดแต่ละคนแยกด้วย authorId (LINE userId ของคนที่พิมพ์จริง — ไม่ใช่ userId ของกลุ่ม)
    const userId = isGroupChat ? (event.source?.groupId ?? event.source?.roomId) : event.source?.userId;
    const authorId = event.source?.userId ?? null; // มีเฉพาะตอนอยู่ในกลุ่ม/ห้อง (1:1 ไม่ต้องใช้ค่านี้)
    if (!userId) continue;

    // --- ในกลุ่ม/ห้อง: ข้อความตัวอักษรต้องขึ้นต้นด้วย "/บอท" เสมอ ไม่งั้นเงียบสนิท ไม่อ่านไม่ตอบ (spec: กลุ่มจดบัญชี) ---
    // รูปภาพไม่ผ่านเงื่อนไขนี้ (แนบ prefix กับรูปพร้อมกันไม่ได้) — คุมด้วย groupLinkService.consumeReceiptWait แทน (ดูด้านล่าง)
    if (isGroupChat && event.message?.type === "text") {
      const stripped = stripBotPrefix(event.message.text.trim());
      if (stripped === null) continue; // ไม่มี "/บอท" นำหน้า -> ไม่ทำอะไรเลย
      event.message.text = stripped; // ตัด prefix ออก แล้วปล่อยให้ logic เดิมด้านล่างทำงานเหมือน 1:1
    }

    if (event.message?.type === "image" && isGroupChat) {
      // ในกลุ่ม รูปภาพจะถูกอ่านก็ต่อเมื่อ "เพิ่งพิมพ์ /บอท สลิป มาก่อน" เท่านั้น (consumeReceiptWait เช็คทั้งคนส่งและเวลา)
      // ไม่มีการสมัคร/จ่าย Premium ในกลุ่มเลย จึงไม่ต้องพึ่ง uploadSessionService/paymentSession แบบ 1:1
      let message;
      try {
        const waiting = await groupLinkService.consumeReceiptWait(userId, authorId);
        if (!waiting) { continue; } // ไม่มีใครสั่ง "/บอท สลิป" ไว้ก่อน (หรือหมดเวลาแล้ว) -> เพิกเฉยรูปนี้ทั้งหมด
        if (!ai || !visionModel) message = noticeFlexMessage("ยังไม่ได้ตั้งค่าโมเดล AI แบบอ่านรูปภาพ (ตั้งค่า OPENAI_VISION_MODEL หรือ OPENAI_MODEL ที่รองรับรูปภาพใน .env) ตอนนี้พิมพ์รายการแทนได้ก่อน เช่น /บอท กาแฟ 60", "info");
        else {
          // ไม่มี "..." กำลังพิมพ์ในกลุ่ม/ห้อง เพราะ LINE ไม่รองรับ loading animation นอกแชท 1:1 (ทำได้แค่แชทเดี่ยวเท่านั้น)
          // เลยตอบข้อความสั้น ๆ ผ่าน reply token ก่อนแทน (ใช้ได้แค่ครั้งเดียว) แล้วค่อย push ผลลัพธ์จริงตามหลัง
          try { await reply(event.replyToken, "รอยายอ่านรูปแป๊บนึงนะจ๊ะ 👀"); } catch (error) { console.error("Could not reply", error.message); }
          try {
            const { mime, base64 } = await downloadLineImage(event.message.id);
            const result = await readReceipt(mime, base64);
            if (result.error === "system") message = noticeFlexMessage("ตอนนี้ระบบอ่านภาพขัดข้องชั่วคราว ไม่เกี่ยวกับความชัดของรูปเลย ลองส่งรูปเดิมอีกครั้งใน 1-2 นาที หรือพิมพ์รายการเองแทนได้เลย เช่น /บอท กาแฟ 60", "error");
            else if (result.error === "unreadable") message = noticeFlexMessage("อ่านยอดเงินจากใบเสร็จนี้ไม่ได้ ลองถ่ายให้เห็นยอดรวมชัด ๆ อีกครั้ง หรือพิมพ์รายการเองแทนได้ เช่น /บอท กาแฟ 60", "error");
            else message = receiptConfirmFlexMessage(result.receipt, { authorId }); // ยังไม่บันทึก รอผู้ใช้กดยืนยันรายรับ/รายจ่ายก่อน (ดู postback handler)
          } catch (error) { console.error("Receipt read failed", error.message); message = noticeFlexMessage("ระบบประมวลผลภาพใช้เวลานานกว่าปกติ กรุณาลองใหม่อีกครั้ง", "error"); }
          try { await push(userId, message); } catch (error) { console.error("Could not push", error.message); }
          continue;
        }
      } catch (error) { console.error("Group image handling failed", error.message); message = noticeFlexMessage("ระบบประมวลผลภาพใช้เวลานานกว่าปกติ กรุณาลองใหม่อีกครั้ง", "error"); }
      try { await (typeof message === "string" ? reply(event.replyToken, message) : replyMessages(event.replyToken, [message])); } catch (error) { console.error("Could not reply", error.message); }
      continue;
    }
    if (event.message?.type === "image") {
      // 1:1 เดิม: รูปภาพอาจเป็น "สลิปการชำระเงิน Premium" (ถ้ามี upload_session ค้างรออยู่) หรือ "ใบเสร็จ" (ฟีเจอร์ Premium)
      // การตัดสินใจว่าเป็นแบบไหน และการตรวจสิทธิ์ Premium เกิดที่ backend เสมอ ไม่เชื่อ Rich Menu ที่ผู้ใช้กดมา (spec §16)
      // ทั้งสองเส้นทางเรียก AI อ่านรูป (readSlip/readReceipt) ซึ่งมักใช้เวลาหลายวินาที จึงโชว์ "..." ให้เห็นทันทีที่รู้ว่าเป็นรูปภาพ
      // ไม่ต้องรอผลว่าจะเป็นสลิปหรือใบเสร็จก่อน เพราะยิงแบบ fire-and-forget (ไม่ await) ไม่เสียเวลาจริง
      startLoadingAnimation(event.source?.userId);
      let message;
      try {
        const routing = await subLineHandlers.handleReceiptOrSlipImage(userId, () => downloadLineImage(event.message.id));
        if (routing.type === "slip") {
          message = routing.message;
        } else if (routing.type === "premium_denied") {
          message = routing.message;
        } else {
          // routing.type === "receipt" && routing.isPremium === true -> ฟีเจอร์เดิม: อ่านใบเสร็จบันทึกบัญชี
          if (!ai || !visionModel) message = noticeFlexMessage("ยังไม่ได้ตั้งค่าโมเดล AI แบบอ่านรูปภาพ (ตั้งค่า OPENAI_VISION_MODEL หรือ OPENAI_MODEL ที่รองรับรูปภาพใน .env) ตอนนี้พิมพ์รายการแทนได้ก่อน เช่น กาแฟ 60", "info");
          else {
            try {
              const { mime, base64 } = await downloadLineImage(event.message.id);
              const result = await readReceipt(mime, base64);
              if (result.error === "system") message = noticeFlexMessage("ตอนนี้ระบบอ่านภาพขัดข้องชั่วคราว ไม่เกี่ยวกับความชัดของรูปเลย ลองส่งรูปเดิมอีกครั้งใน 1-2 นาที หรือพิมพ์รายการเองแทนได้เลย เช่น กาแฟ 60", "error");
              else if (result.error === "unreadable") message = noticeFlexMessage("อ่านยอดเงินจากใบเสร็จนี้ไม่ได้ ลองถ่ายให้เห็นยอดรวมชัด ๆ อีกครั้ง หรือพิมพ์รายการเองแทนได้ เช่น กาแฟ 60", "error");
              else message = receiptConfirmFlexMessage(result.receipt); // ยังไม่บันทึก รอผู้ใช้กดยืนยันรายรับ/รายจ่ายก่อน (ดู postback handler)
            } catch (error) { console.error("Receipt read failed", error.message); message = noticeFlexMessage("ระบบประมวลผลภาพใช้เวลานานกว่าปกติ กรุณาลองใหม่อีกครั้ง", "error"); }
          }
        }
      } catch (error) { console.error("Image handling failed", error.message); message = noticeFlexMessage("ระบบประมวลผลภาพใช้เวลานานกว่าปกติ กรุณาลองใหม่อีกครั้ง", "error"); }
      try { await (typeof message === "string" ? reply(event.replyToken, message) : replyMessages(event.replyToken, [message])); } catch (error) { console.error("Could not reply", error.message); }
      continue;
    }
    if (event.message?.type !== "text") continue;
    const text = event.message.text.trim();

    // --- คำสั่งเฉพาะกลุ่ม: ยืนยันความเป็นเจ้าของ (spec: กลุ่มจดบัญชี) ---
    if (isGroupChat && text === "ยืนยันเจ้าของ") {
      let message;
      try {
        const result = await groupLinkService.confirmOwner(userId, authorId);
        if (result.ok) {
          message = noticeFlexMessage("ยืนยันสำเร็จ กลุ่มนี้ปลดล็อกฟีเจอร์ Premium แล้ว (ใช้ได้เฉพาะในกลุ่มนี้เท่านั้น)\n\nทุกคำสั่งต้องขึ้นต้นด้วย \"/บอท\" เสมอ เช่น \"/บอท กาแฟ 60\"", "success");
        } else if (result.reason === "NOT_PREMIUM") {
          message = noticeFlexMessage("บัญชีของคุณยังไม่ใช่ Premium ยายจันทร์ขอตัวออกจากกลุ่มนี้นะคะ 🙏\nถ้าอยากใช้งานฟีเจอร์นี้ ต้องสมัคร Premium แบบส่วนตัวกับยายจันทร์ก่อน (แชท 1:1 พิมพ์ \"สมัครพรีเมียม\")", "error");
          try { await replyMessages(event.replyToken, [message]); } catch (error) { console.error("Could not reply", error.message); }
          try { await leaveGroup(userId); await groupLinkService.markLeft(userId); } catch (error) { console.error("Leaving group after rejection failed:", error.message); }
          continue;
        } else if (result.reason === "EXPIRED") {
          message = noticeFlexMessage("หมดเวลายืนยันแล้ว ยายจันทร์ขอตัวออกจากกลุ่มนี้นะคะ 🙏 เชิญเข้ามาใหม่ได้เลยถ้าต้องการลองอีกครั้ง", "error");
          try { await replyMessages(event.replyToken, [message]); } catch (error) { console.error("Could not reply", error.message); }
          try { await leaveGroup(userId); await groupLinkService.markLeft(userId); } catch (error) { console.error("Leaving group after expiry failed:", error.message); }
          continue;
        } else {
          message = noticeFlexMessage("กลุ่มนี้ยืนยันเจ้าของไปแล้ว หรือไม่มีคำขอที่รอยืนยันอยู่", "info");
        }
      } catch (error) { console.error("Confirm owner failed", error.message); message = noticeFlexMessage("เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง", "error"); }
      try { await replyMessages(event.replyToken, [message]); } catch (error) { console.error("Could not reply", error.message); }
      continue;
    }

    // --- Premium subscription commands: เช็คก่อน finance parser เสมอ เพื่อไม่ให้ "สมัครพรีเมียม" ถูกตีความเป็นรายการบัญชี ---
    // ห้ามสมัคร/ต่ออายุ Premium จากในกลุ่มเด็ดขาด (spec: ต้องไปสมัครแบบ 1:1 เท่านั้น) — งดคำสั่งนี้ในกลุ่ม
    if (!isGroupChat && text === "สมัครพรีเมียม") {
      let result;
      try { result = await subLineHandlers.handleSubscribeCommand(userId); }
      catch (error) { console.error("Subscribe command failed", error.message); result = { text: "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง" }; }
      const messages = [];
      if (result.qrImageUrl) messages.push(qrImageMessage(result.qrImageUrl));
      messages.push({ type: "text", text: result.text.slice(0, 4900) });
      try { await replyMessages(event.replyToken, messages); } catch (error) { console.error("Could not reply", error.message); }
      continue;
    }
    if (isGroupChat && text === "สมัครพรีเมียม") {
      try { await replyMessages(event.replyToken, [noticeFlexMessage("สมัคร Premium ทำได้เฉพาะแชทส่วนตัวกับยายจันทร์เท่านั้นนะ ไปคุย 1:1 แล้วพิมพ์ \"สมัครพรีเมียม\" ได้เลย\n\nพอสมัครเสร็จแล้ว เชิญยายจันทร์เข้ากลุ่มนี้ (หรือกลุ่มอื่น) แล้วพิมพ์ \"/บอท ยืนยันเจ้าของ\" เพื่อปลดล็อก Premium ให้ทั้งกลุ่มได้เลย", "info")]); } catch (error) { console.error("Could not reply", error.message); }
      continue;
    }
    if (!isGroupChat && text === "ส่งสลิป") {
      let message;
      try { message = await subLineHandlers.handleSendSlipCommand(userId); }
      catch (error) { console.error("Send-slip command failed", error.message); message = "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง"; }
      try { await replyMessages(event.replyToken, [noticeFlexMessage(message, "info")]); } catch (error) { console.error("Could not reply", error.message); }
      continue;
    }
    // ในกลุ่ม "/บอท สลิป" ใช้แค่เพื่อ "รอรับรูปใบเสร็จ" มาจดรายจ่ายกองกลาง (ต้องเป็นกลุ่ม Premium อยู่แล้วเท่านั้น)
    // คนละเรื่องกับ "ส่งสลิป" แบบ 1:1 ที่ผูกกับ payment_session ตอนสมัคร Premium — ในกลุ่มไม่มี payment_session ให้ผูก
    // จึงใช้ groupLinkService.openReceiptWait/consumeReceiptWait แทน uploadSessionService โดยสิ้นเชิง
    if (isGroupChat && text === "สลิป") {
      let message, tone = "info";
      try {
        const isPremiumGroup = await groupLinkService.isPremiumGroup(userId);
        if (!isPremiumGroup) { message = "กลุ่มนี้ยังไม่ได้ปลดล็อก Premium นะ (ต้องมีสมาชิก Premium เป็นเจ้าของกลุ่ม)\nไปสมัคร Premium แบบ 1:1 กับยายจันทร์ก่อน แล้วเชิญเข้ากลุ่มพร้อมพิมพ์ \"/บอท ยืนยันเจ้าของ\""; tone = "error"; }
        else { await groupLinkService.openReceiptWait(userId, authorId); message = "กรุณาส่งรูปใบเสร็จตามมาได้เลย 🧾"; }
      } catch (error) { console.error("Group slip command failed", error.message); message = "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง"; tone = "error"; }
      try { await replyMessages(event.replyToken, [noticeFlexMessage(message, tone)]); } catch (error) { console.error("Could not reply", error.message); }
      continue;
    }

    const user = await getUser(userId);
    if (applyRecurring(user)) await saveUser(userId, user);
    let message;
    const helpText = isGroupChat
      ? "📒 ยายจันทร์พร้อมจดบัญชีกองกลางให้กลุ่มนี้\n\nทุกคำสั่งต้องขึ้นต้นด้วย \"/บอท\" เสมอ เช่น:\n/บอท กาแฟ 60\n/บอท เงินเดือน 15000\n/บอท สลิป (แล้วส่งรูปใบเสร็จตาม — ต้องมีสมาชิก Premium เป็นเจ้าของกลุ่มนี้ก่อน)\n/บอท สรุปวันนี้ | /บอท สรุปเดือนนี้ | /บอท ลบล่าสุด | /บอท เว็บ\n\nสมัคร Premium ต้องไปแชท 1:1 กับยายจันทร์เท่านั้น"
      : "📒 ยายจันทร์พร้อมจดบัญชีของคุณ (ข้อมูลของแต่ละคนแยกกันเป็นส่วนตัว)\n\nพิมพ์: กาแฟ 60\nรายรับ: เงินเดือน 15000\nถ่ายรูปใบเสร็จส่งมาได้เลย (ฟีเจอร์ Premium) ยายจันทร์จะอ่านยอดกับร้านค้าให้อัตโนมัติ\nคำสั่ง: สรุปวันนี้ | สรุปเดือนนี้ | ลบล่าสุด | เว็บ | สมัครพรีเมียม\nทุกวันอาทิตย์ยายจันทร์จะสรุปสัปดาห์ให้อัตโนมัติด้วย\n\nหรือถามยายจันทร์ได้เลย เช่น \"เดือนนี้ใช้เงินไปกับอะไรมากสุด\" ยายจันทร์เน้นตอบเรื่องการเงินเป็นหลัก แต่คุยเรื่องอื่นได้ด้วยนะ";
    if (["เริ่ม", "ช่วยเหลือ", "help"].includes(text.toLowerCase())) message = helpText;
    else if (text === "สรุปวันนี้") message = summary(user.transactions.filter((tx) => sameDay(tx.createdAt)), "วันนี้");
    else if (text === "สรุปเดือนนี้") { const month = user.transactions.filter((tx) => sameMonth(tx.createdAt)); message = `${summary(month, "เดือนนี้")}\n\n${advice(month)}`; }
    else if (text === "ลบล่าสุด") { const tx = user.transactions.pop(); if (tx) { await saveUser(userId, user); message = noticeFlexMessage(`ลบแล้ว: ${tx.description} ${money(tx.amount)} บาท`, "success"); } else message = noticeFlexMessage("ยังไม่มีรายการให้ลบ", "info"); }
    else if (text === "เว็บ") message = dashboardFlexMessage(user, { isGroupChat, dashboardUrl: dashboardEditUrl(userId) });
    else {
      let tx = parse(text);
      if (tx) {
        const ambiguous = tx._typeAmbiguous; delete tx._typeAmbiguous;
        tx = await enrichWithAi(tx, text, ambiguous);
        if (isGroupChat) tx = { ...tx, authorId, authorName: await getGroupMemberName(userId, authorId) };
        user.transactions.push(tx); await saveUser(userId, user);
        // confirmMessagePrefs ใช้ได้ทั้งกลุ่มและแชทส่วนตัว (ฟีเจอร์ Premium) — ผู้ใช้ที่ไม่เคยตั้งค่าจะได้ default เดิมอยู่แล้ว (ดู defaultConfirmMessagePrefs)
        message = txFlexMessage(tx, { budget: budgetProgressFor(user, tx), dashboardUrl: dashboardEditUrl(userId), userId, prefs: user.confirmMessagePrefs });
      }
      else {
        const aiAnswer = await askFinanceAi(user, text);
        message = aiAnswer ?? (isGroupChat ? "พิมพ์ได้เลย เช่น /บอท กาแฟ 60 หรือ /บอท เงินเดือน 15000\nพิมพ์ /บอท ช่วยเหลือ เพื่อดูคำสั่ง" : "พิมพ์ได้เลย เช่น กาแฟ 60 หรือ เงินเดือน 15000\nพิมพ์ ช่วยเหลือ เพื่อดูคำสั่ง");
      }
    }
    try { await (typeof message === "string" ? reply(event.replyToken, message) : replyMessages(event.replyToken, [message])); } catch (error) { console.error("Could not reply", error.message); }
  }
});
app.listen(Number(process.env.PORT ?? 3000), () => console.log(`Ta Phin listening on ${process.env.PORT ?? 3000}`));










