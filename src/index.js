import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import QRCode from "qrcode";
import OpenAI from "openai";
import cron from "node-cron";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

import { buildSubscriptionCollections } from "./subscription/db.js";
import { createAuditLogger } from "./subscription/auditLog.js";
import { createSubscriptionService } from "./subscription/subscriptions.js";
import { createPaymentSessionService } from "./subscription/paymentSessions.js";
import { createUploadSessionService } from "./subscription/uploadSessions.js";
import { createPaymentTransactionService } from "./subscription/paymentTransactions.js";
import { getPaymentProvider } from "./subscription/paymentProvider.js";
import { createQrService } from "./subscription/qr.js";
import { createRichMenuService } from "./subscription/richMenu.js";
import { createSubscriptionLineHandlers } from "./subscription/lineHandlers.js";
import { createGroupLinkService, CONFIRM_WINDOW_MINUTES } from "./subscription/groupLinks.js";
import { createMemoryService } from "./memory/memoryService.js";
import { extractMemoryFromText } from "./memory/extractMemory.js";
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
const memoriesCol = getFirestore(firebaseApp).collection("panuan_memories");
const memoryService = createMemoryService({ memories: memoriesCol, FieldValue });
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

function emptyUser() { return { transactions: [], recurring: [], budgets: {} }; }
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
    if (needCategory) instructions.push('"category": จัดหมวดรายจ่ายนี้เป็นหนึ่งใน อาหาร, เดินทาง, บิล, สุขภาพ, บันเทิง, ช้อปปิ้ง, อื่น ๆ (ใส่เฉพาะกรณีเป็นรายจ่ายเท่านั้น)');
    const fields = [needType ? '"type":"income"|"expense"' : null, needCategory ? '"category":"..."' : null].filter(Boolean).join(", ");
    const completion = await ai.chat.completions.create({
      model: process.env.OPENAI_MODEL,
      temperature: 0,
      max_tokens: 60,
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
    if (needCategory && next.type === "expense" && Object.hasOwn(CATEGORIES, parsed.category)) {
      next = { ...next, category: parsed.category };
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
async function replyMessages(token, messages) { return line("reply", { replyToken: token, messages }); }
async function reply(token, text) { return replyMessages(token, [{ type: "text", text: text.slice(0, 4900) }]); }
async function push(to, text) { return line("push", { to, messages: [{ type: "text", text: text.slice(0, 4900) }] }); }
function qrImageMessage(url) { return { type: "image", originalContentUrl: url, previewImageUrl: url }; }

// การ์ด Flex Message แสดงผลตอนจดรายการสำเร็จ (แทนข้อความ text ธรรมดา)
// tx: รายการที่เพิ่งบันทึก, opts.budget: { limit, spent } หมวดนี้ในเดือนนี้ (ถ้ามีตั้งงบไว้), opts.dashboardUrl: ลิงก์แก้ไข/ลบผ่านเว็บ
function txFlexMessage(tx, opts = {}) {
  const isIncome = tx.type === "income";
  const typeLabel = isIncome ? "รายรับ" : "รายจ่าย";
  const pink = "#D23283";
  const cream = "#FBF3EC";
  const { budget, dashboardUrl } = opts;

  const bodyContents = [
    // แถวแท็ก: ประเภท + หมวดหมู่ (พื้นชมพู ตัวอักษรขาว)
    {
      type: "box",
      layout: "baseline",
      spacing: "sm",
      contents: [
        {
          type: "text",
          text: typeLabel,
          size: "xs",
          weight: "bold",
          color: "#FFFFFF",
          align: "center",
          gravity: "center",
          backgroundColor: pink,
          cornerRadius: "12px",
          paddingAll: "6px",
          paddingStart: "10px",
          paddingEnd: "10px",
          flex: 0
        },
        {
          type: "text",
          text: tx.category,
          size: "xs",
          weight: "bold",
          color: pink,
          align: "center",
          gravity: "center",
          backgroundColor: "#FCE4EF",
          cornerRadius: "12px",
          paddingAll: "6px",
          paddingStart: "10px",
          paddingEnd: "10px",
          flex: 0
        }
      ]
    },
    // ชื่อรายการ
    { type: "text", text: tx.description || typeLabel, size: "md", weight: "bold", color: "#3A3540", margin: "md", wrap: true },
    tx.authorName ? { type: "text", text: `ผู้จด: ${tx.authorName}`, size: "xs", color: "#9B94A0", margin: "xs" } : null,
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

  // แถบ progress bar เทียบยอดรวม (หมวดนี้/เดือนนี้) กับงบที่ตั้งไว้ — แสดงเฉพาะรายจ่ายที่มีการตั้งงบหมวดนี้
  if (!isIncome && budget && budget.limit > 0) {
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
              { type: "text", text: `${money(budget.spent)} / ${money(budget.limit)} บาท`, size: "xs", color: overBudget ? "#D23283" : "#9B94A0", align: "end" }
            ]
          },
          {
            type: "box",
            layout: "horizontal",
            height: "8px",
            cornerRadius: "4px",
            contents: [
              { type: "box", layout: "vertical", flex: Math.max(Math.round(ratio * 100), 4), backgroundColor: overBudget ? "#B0225F" : pink, contents: [] },
              { type: "box", layout: "vertical", flex: Math.max(100 - Math.round(ratio * 100), 0), backgroundColor: "#F1E7DC", contents: [] }
            ]
          },
          overBudget ? { type: "text", text: "เกินงบที่ตั้งไว้แล้วนะ", size: "xxs", color: "#B0225F", margin: "xs" } : null
        ].filter(Boolean)
      }
    );
  }

  const footerButtons = [];
  if (dashboardUrl) {
    footerButtons.push(
      { type: "button", style: "secondary", height: "sm", color: "#F1E7DC", action: { type: "uri", label: "แก้ไข", uri: dashboardUrl } },
      { type: "button", style: "secondary", height: "sm", color: "#FCE4EF", action: { type: "uri", label: "ลบ", uri: dashboardUrl } }
    );
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
// คำนวณยอดรวมหมวดนี้ในเดือนนี้ เทียบกับงบที่ตั้งไว้ (ถ้ามี) สำหรับ progress bar ใน Flex Message
function budgetProgressFor(user, tx) {
  if (tx.type !== "expense") return null;
  const limit = user.budgets?.[tx.category];
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const spent = user.transactions.filter((t) => t.type === "expense" && t.category === tx.category && sameMonth(t.createdAt)).reduce((sum, t) => sum + t.amount, 0);
  return { limit, spent };
}
function dashboardEditUrl(userId) {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  return base ? `${base}/dashboard?token=${perUserToken(userId)}&u=${encodeURIComponent(userId)}` : null;
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
async function askFinanceAi(user, question, memoryContext = "") {
  if (!ai || !process.env.OPENAI_MODEL) return null;
  try {
    const month = user.transactions.filter((tx) => sameMonth(tx.createdAt));
    const t = totals(month);
    const top = Object.entries(month.filter((tx) => tx.type === "expense").reduce((o, tx) => ({ ...o, [tx.category]: (o[tx.category] ?? 0) + tx.amount }), {})).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const budgetLines = Object.entries(user.budgets ?? {}).map(([category, amount]) => `${category}: งบ ${money(amount)} บาท`).join("\n") || "ยังไม่ได้ตั้งงบ";
    const context = `ข้อมูลบัญชีเดือนนี้ของผู้ใช้คนนี้เท่านั้น (ห้ามอ้างอิงคนอื่น):\nรายรับ: ${money(t.income)} บาท\nรายจ่าย: ${money(t.expense)} บาท\nคงเหลือ: ${money(t.income - t.expense)} บาท\nหมวดที่ใช้จ่ายมากสุด: ${top.map(([category, value]) => `${category} ${money(value)} บาท`).join(", ") || "ยังไม่มีข้อมูล"}\nงบประมาณที่ตั้งไว้:\n${budgetLines}${memoryContext}`;
    const completion = await ai.chat.completions.create({
      model: process.env.OPENAI_MODEL,
      temperature: 0.4,
      max_tokens: 400, // คำตอบสั้น ๆ ไม่เกิน 4 ประโยคอยู่แล้วตาม system prompt — จำกัดไว้กันโมเดลบางตัวลากยาว/คิดนานเกินจำเป็นจนตอบช้า
      messages: [
        { role: "system", content: "คุณคือ \"ยายจันทร์\" คุณยายที่ช่วยหลานดูแลเรื่องเงิน พูดกับผู้ใช้เหมือนยายคุยกับหลานตัวเองตามธรรมชาติ ไม่ใช่พนักงานหรือบอทที่พูดจาเป็นทางการ ใช้น้ำเสียงเป็นกันเอง อบอุ่น ตรงไปตรงมาแบบผู้ใหญ่ใจดี ห้ามลงท้ายประโยคด้วยคำว่า \"ครับ\" หรือ \"ค่ะ\"/\"คะ\" เด็ดขาด ให้พูดห้วนแบบยายคุยกับหลานแทน (เช่น พูดจบประโยคเฉย ๆ หรือใช้คำลงท้ายกันเองแบบ \"นะ\" \"นะเนี่ย\" \"เอาไหม\" \"เห็นไหม\" ได้บ้างแต่ไม่ต้องทุกประโยค) หลีกเลี่ยงศัพท์ทางการหรือภาษาเขียนแข็ง ๆ ให้เน้นให้คำปรึกษาและตอบคำถามด้านการเงินส่วนบุคคล (การออม การใช้จ่าย การตั้งงบประมาณ หนี้สิน หลักการลงทุนเบื้องต้น) โดยใช้ข้อมูลบัญชีของผู้ใช้ที่ให้มาประกอบการตอบเมื่อเกี่ยวข้อง ถ้ามี \"ข้อมูลที่เคยจำไว้เกี่ยวกับผู้ใช้คนนี้โดยเฉพาะ\" ให้ใช้เรียกชื่อหรืออ้างอิงอย่างเป็นธรรมชาติเมื่อเหมาะสม แต่ห้ามพูดถึงข้อมูลนี้กับคนอื่นเด็ดขาด แม้จะอยู่ในกลุ่มแชทเดียวกันก็ตาม คุณตอบคำถามทั่วไปอื่น ๆ นอกเรื่องการเงินได้เช่นกันแบบสั้นและเป็นมิตร แต่เมื่อมีโอกาสให้โยงกลับมาช่วยเรื่องการเงินอย่างเป็นธรรมชาติ กระชับ ไม่เกิน 4 ประโยค เหมาะสำหรับส่งทางแชท ห้ามให้คำแนะนำการลงทุนเฉพาะเจาะจงที่มีความเสี่ยงสูงหรือรับประกันผลตอบแทน และห้ามให้คำแนะนำทางกฎหมายหรือภาษีแบบฟันธง ให้แนะนำปรึกษาผู้เชี่ยวชาญแทนในกรณีนั้น" },
        { role: "user", content: `${context}\n\nคำถามจากผู้ใช้: ${question}` }
      ]
    });
    return completion.choices[0]?.message?.content?.trim() || null;
  } catch (error) { console.warn("AI answer failed:", error.message); return null; }
}
async function downloadLineImage(messageId) {
  const r = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, { headers: { authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` } });
  if (!r.ok) throw new Error(`LINE content: ${r.status}`);
  const mime = r.headers.get("content-type") || "image/jpeg";
  const buffer = Buffer.from(await r.arrayBuffer());
  return { mime, base64: buffer.toString("base64") };
}
async function readReceipt(mime, base64) {
  if (!ai || !visionModel) return null;
  try {
    const completion = await ai.chat.completions.create({
      model: visionModel,
      temperature: 0,
      max_tokens: 150,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You read Thai/English receipt photos. Reply only JSON: {\"merchant\":\"...\",\"amount\":number}. \"amount\" is the final total paid (บาท), as a plain number with no currency symbol or commas. If you cannot read a merchant name, use \"อื่น ๆ\". If you cannot find a clear total amount, set amount to 0." },
        { role: "user", content: [
          { type: "text", text: "อ่านยอดรวมและชื่อร้านค้าจากใบเสร็จนี้" },
          { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } }
        ] }
      ]
    });
    const parsed = JSON.parse(completion.choices[0]?.message?.content ?? "{}");
    const amount = Number(parsed.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) return null;
    const merchant = String(parsed.merchant ?? "อื่น ๆ").trim().slice(0, 120) || "อื่น ๆ";
    return { merchant, amount };
  } catch (error) { console.warn("Receipt AI read failed:", error.message); return null; }
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

const legacyDashboard = String.raw`<!doctype html>
<html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>รายการ | ยายจันทร์</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#faf9f7;color:#25242a;font-family:system-ui,-apple-system,"Noto Sans Thai",sans-serif}.app{max-width:440px;min-height:100vh;margin:auto;background:#fff;padding-bottom:100px}.top{padding:16px 20px 12px;border-bottom:1px solid #eee}.top b{font-size:19px}.site{font-size:12px;color:#b0adb0;margin-top:3px}.close{float:right;font-size:32px;font-weight:300;line-height:20px;color:#222}main{padding:18px}.date,.filters,.toolbar,.item{border:1px solid #ebe8e8;border-radius:13px;background:white;box-shadow:0 1px 3px #0000000d}.date{padding:16px;text-align:center;font-weight:700;font-size:16px}.filters{padding:10px 13px;margin-top:17px}.filters h2{font-size:18px;margin:0 0 10px}.chips{display:flex;gap:8px}.chip{border:0;border-radius:6px;background:#e9e9ee;color:#3e3d42;padding:5px 20px;font-size:14px}.chip.active{background:#d23283;color:#fff}.tools{display:grid;grid-template-columns:1fr 1fr 70px;gap:8px;margin-top:17px}.toolbar{border-radius:9px;padding:8px 11px;color:#777;text-align:center;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.export{border:1px solid #ebe8e8;border-radius:13px;background:#fff;font-size:13px;font-weight:600}.day{display:flex;justify-content:space-between;align-items:center;padding:15px 15px 5px;border-bottom:2px solid #a7adb9;color:#6c6b72;font-size:14px}.total{color:#bd3e78;font-weight:700}.item{display:grid;grid-template-columns:1fr auto;align-items:center;padding:15px 18px;margin-top:14px;cursor:pointer}.desc{font-weight:700;font-size:16px}.meta{font-size:14px;color:#777;margin-top:8px}.badge{background:#f1f1f3;border-radius:4px;padding:3px 9px;margin-left:10px}.money{font-size:16px;font-weight:700}.expense{color:#c14379}.income{color:#07835b}.arrow{color:#a0a0a4;font-size:25px;margin-left:10px}.add{position:fixed;right:max(20px,calc((100vw - 440px)/2 + 18px));bottom:80px;border:0;background:#d23283;color:#fff;width:64px;height:64px;border-radius:50%;font-size:42px;box-shadow:0 4px 10px #a8105c66}.nav{position:fixed;bottom:0;left:50%;transform:translateX(-50%);width:min(440px,100%);height:72px;background:#fff;border-top:1px solid #e8e7e7;display:flex;justify-content:space-around;padding-top:10px}.nav span{font-size:12px;color:#9b9ba0;text-align:center}.nav i{display:block;font-style:normal;font-size:24px;line-height:27px}.nav .selected{color:#c43d7a}.modal{position:fixed;inset:0;background:#0008;display:none;align-items:end;justify-content:center}.modal.open{display:flex}.sheet{width:min(440px,100%);background:#fff;border-radius:22px 22px 0 0;padding:20px}.sheet h2{margin:0 0 16px}.sheet label{display:block;font-size:13px;margin:11px 0 4px;color:#65636a}.sheet input,.sheet select{width:100%;border:1px solid #ddd;border-radius:9px;padding:11px;font:inherit}.actions{display:flex;gap:8px;margin-top:18px}.save,.cancel,.delete{border:0;border-radius:9px;padding:12px;flex:1;font:inherit;font-weight:700}.save{background:#d23283;color:#fff}.cancel{background:#eee}.delete{background:#fff0f3;color:#c22;border:1px solid #f1cbd3}.empty{text-align:center;color:#9b9b9f;padding:36px 0}
</style><body><div class="app"><header class="top"><button class="close" aria-label="ปิด">×</button><b>รายการ</b><div class="site">app.panuan.com</div></header><main><div class="date" id="period">เดือนนี้&nbsp; 📅</div><section class="filters"><h2>คัดกรองประเภทรายการ</h2><div class="chips"><button class="chip active" data-type="all">ทั้งหมด</button><button class="chip" data-type="expense">รายจ่าย</button><button class="chip" data-type="income">รายรับ</button></div></section><div class="tools"><button class="toolbar" id="select">เลือกหลายรายการ ☷</button><button class="toolbar" id="refresh">ตั้งรายการรอดประจำ ↻</button><button class="export" id="export">⇩<br>ส่งออก</button></div><div id="list"></div></main></div><button class="add" id="add" aria-label="เพิ่มรายการ">+</button><nav class="nav"><span><i>⌂</i>สรุป</span><span><i>▥</i>วิเคราะห์</span><span><i>◴</i>หมวด / งบ</span><span class="selected"><i>☷</i>รายการ</span><span><i>⚙</i>ตั้งค่า</span></nav><div class="modal" id="modal"><form class="sheet" id="form"><h2 id="formTitle">เพิ่มรายการ</h2><label>ประเภทรายการ</label><select id="type"><option value="expense">รายจ่าย</option><option value="income">รายรับ</option></select><label>ชื่อรายการ</label><input id="description" required placeholder="เช่น ค่าอาหาร"><label>จำนวนเงิน (บาท)</label><input id="amount" required type="number" min="0.01" step="0.01" placeholder="0"><label>หมวดหมู่</label><input id="category" required placeholder="เช่น อื่น ๆ"><label>วันที่และเวลา</label><input id="createdAt" required type="datetime-local"><input id="id" type="hidden"><div class="actions"><button class="delete" type="button" id="remove" hidden>ลบ</button><button class="cancel" type="button" id="cancel">ยกเลิก</button><button class="save">บันทึก</button></div></form></div><script>
const token=new URLSearchParams(location.search).get('token'),q='?token='+encodeURIComponent(token),fmt=n=>new Intl.NumberFormat('th-TH',{style:'currency',currency:'THB',maximumFractionDigits:2}).format(n),esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));let data=[],filter='all';
async function api(url,opt){const r=await fetch(url+q,opt);if(!r.ok)throw new Error('บันทึกไม่สำเร็จ');return r.json()}
function render(){const rows=data.filter(x=>filter==='all'||x.type===filter),groups={};rows.forEach(x=>{const d=x.date||new Date(x.createdAt).toLocaleDateString('th-TH',{day:'numeric',month:'short'});(groups[d]??=[]).push(x)});list.innerHTML=Object.entries(groups).map(([d,a])=>{const total=a.reduce((s,x)=>s+(x.type==='income'?x.amount:-x.amount),0);return '<div class="day"><span>'+d+'</span><span class="total">รวม: '+(total>=0?'+':'-')+fmt(Math.abs(total))+'</span></div>'+a.map(x=>'<article class="item" data-id="'+x.id+'"><div><div class="desc">'+esc(x.description)+'</div><div class="meta">'+new Date(x.createdAt).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'})+' น. <span class="badge">'+esc(x.category)+'</span></div></div><div><span class="money '+x.type+'">'+(x.type==='income'?'+':'-')+fmt(x.amount)+'</span><span class="arrow">›</span></div></article>').join('')}).join('')||'<div class="empty">ยังไม่มีรายการ<br>กด + เพื่อเพิ่มรายการ</div>';document.querySelectorAll('.item').forEach(e=>e.onclick=()=>open(data.find(x=>x.id===e.dataset.id)))}
async function load(){const d=await api('/api/transactions');data=d.transactions;period.textContent=d.label+'  📅';render()}
function local(dt){const d=new Date(dt),z=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+z(d.getMonth()+1)+'-'+z(d.getDate())+'T'+z(d.getHours())+':'+z(d.getMinutes())}
function open(x){form.reset();id.value=x?.id||'';formTitle.textContent=x?'แก้ไขรายการ':'เพิ่มรายการ';type.value=x?.type||'expense';description.value=x?.description||'';amount.value=x?.amount||'';category.value=x?.category||'อื่น ๆ';createdAt.value=x?local(x.createdAt):local(new Date());remove.hidden=!x;modal.classList.add('open')}
document.querySelectorAll('.chip').forEach(b=>b.onclick=()=>{filter=b.dataset.type;document.querySelectorAll('.chip').forEach(x=>x.classList.toggle('active',x===b));render()});add.onclick=()=>open();cancel.onclick=()=>modal.classList.remove('open');refresh.onclick=load;form.onsubmit=async e=>{e.preventDefault();const body=JSON.stringify({type:type.value,description:description.value.trim(),amount:Number(amount.value),category:category.value.trim(),createdAt:new Date(createdAt.value).toISOString()});try{await api(id.value?'/api/transactions/'+id.value:'/api/transactions',{method:id.value?'PUT':'POST',headers:{'content-type':'application/json'},body});modal.classList.remove('open');load()}catch(e){alert(e.message)}};remove.onclick=async()=>{if(confirm('ลบรายการนี้?')){await api('/api/transactions/'+id.value,{method:'DELETE'});modal.classList.remove('open');load()}};export.onclick=()=>location='/api/transactions/export'+q;load().catch(()=>document.body.innerHTML='<p>เข้าถึงไม่ได้: ตรวจลิงก์แดชบอร์ด</p>');
</script><script>
let selecting=false,selectedIds=new Set(),monthFilter='';const baseRender=render;
function updateSelectButton(){select.textContent=selecting?'ลบที่เลือก ('+selectedIds.size+')':'เลือกหลายรายการ ☷'}
render=function(){const original=data;if(monthFilter)data=data.filter(x=>x.createdAt.slice(0,7)===monthFilter);baseRender();data=original;period.title='กดเพื่อเลือกเดือน';document.querySelectorAll('.item').forEach(card=>{if(!selecting)return;const box=document.createElement('input');box.type='checkbox';box.checked=selectedIds.has(card.dataset.id);box.style.cssText='width:20px;height:20px;margin-right:12px;accent-color:#d23283';box.onclick=e=>{e.stopPropagation();box.checked?selectedIds.add(card.dataset.id):selectedIds.delete(card.dataset.id);updateSelectButton()};card.prepend(box);card.onclick=e=>{if(e.target!==box){box.checked=!box.checked;box.checked?selectedIds.add(card.dataset.id):selectedIds.delete(card.dataset.id);updateSelectButton()}}});updateSelectButton()};
select.onclick=async()=>{if(!selecting){selecting=true;selectedIds.clear();render();return}if(!selectedIds.size){selecting=false;render();return}if(!confirm('ลบ '+selectedIds.size+' รายการที่เลือก?'))return;try{await Promise.all([...selectedIds].map(id=>api('/api/transactions/'+id,{method:'DELETE'})));selecting=false;selectedIds.clear();await load()}catch(e){alert(e.message)}};
period.onclick=()=>{const value=prompt('เลือกเดือน (รูปแบบ YYYY-MM)\nเว้นว่างเพื่อแสดงทั้งหมด',monthFilter);if(value===null)return;if(value!==''&&!/^\d{4}-\d{2}$/.test(value)){alert('รูปแบบเดือนไม่ถูกต้อง');return}monthFilter=value;period.textContent=monthFilter||'ทุกเดือน';render()};
refresh.onclick=async()=>{const description=prompt('ชื่อรายการประจำ เช่น ค่าเช่า');if(!description)return;const amount=Number(prompt('จำนวนเงิน (บาท)'));const category=prompt('หมวดหมู่','อื่น ๆ');const day=Number(prompt('ให้บันทึกทุกวันที่ (1-31)',String(new Date().getDate())));if(!Number.isFinite(amount)||amount<=0||!category||!Number.isInteger(day)||day<1||day>31){alert('ข้อมูลไม่ถูกต้อง');return}try{await api('/api/recurring',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:confirm('กด OK สำหรับรายรับ\nกด Cancel สำหรับรายจ่าย')?'income':'expense',description,amount,category,day})});alert('ตั้งรายการประจำแล้ว ระบบจะสร้างรายการให้อัตโนมัติทุกเดือน')}catch(e){alert(e.message)}};
document.querySelector('.close').onclick=()=>history.length>1?history.back():location.href='about:blank';document.querySelectorAll('.nav span').forEach(item=>item.onclick=()=>{if(item.classList.contains('selected'))return;alert('หน้านี้กำลังอยู่ระหว่างจัดทำ ตอนนี้คุณจัดการรายการได้ครบจากหน้านี้')});load();
</script></body></html>`;
const dashboard = await fs.readFile(path.join(__dirname, "dashboard.html"), "utf8");

app.get("/health", (_req, res) => res.json({ ok: true, app: "pa-nuan" }));
app.get("/dashboard", (req, res) => allowed(req) ? res.type("html").send(dashboard) : res.sendStatus(401));
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
    // --- บอทถูกเชิญเข้ากลุ่ม/ห้อง: เริ่มรอยืนยันเจ้าของ (spec: กลุ่มจดบัญชี) ---
    if (event.type === "join") {
      const groupId = event.source?.groupId ?? event.source?.roomId;
      if (!groupId) continue;
      try {
        await groupLinkService.startPending(groupId);
        await reply(event.replyToken, `สวัสดีค่ะ ยายจันทร์พร้อมจดบัญชีกองกลางให้กลุ่มนี้ 📒\n\nฟีเจอร์นี้ใช้ได้เฉพาะกลุ่มที่มีสมาชิก Premium เชิญเข้ามาเท่านั้น\nถ้าคุณเป็น Premium อยู่แล้ว พิมพ์:\n/บอท ยืนยันเจ้าของ\n\nภายใน ${CONFIRM_WINDOW_MINUTES} นาที ไม่งั้นยายจันทร์ขอตัวออกจากกลุ่มนะคะ\n\nทุกคำสั่งในกลุ่มต้องขึ้นต้นด้วย "/บอท" เสมอ เช่น "/บอท กาแฟ 60"`);
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
        if (!ai || !visionModel) message = "ยังไม่ได้ตั้งค่าโมเดล AI แบบอ่านรูปภาพ (ตั้งค่า OPENAI_VISION_MODEL หรือ OPENAI_MODEL ที่รองรับรูปภาพใน .env) ตอนนี้พิมพ์รายการแทนได้ก่อน เช่น /บอท กาแฟ 60";
        else {
          try {
            const { mime, base64 } = await downloadLineImage(event.message.id);
            const receipt = await readReceipt(mime, base64);
            if (!receipt) message = "อ่านยอดเงินจากใบเสร็จนี้ไม่ได้ ลองถ่ายให้เห็นยอดรวมชัด ๆ อีกครั้ง หรือพิมพ์รายการเองแทนได้ เช่น /บอท กาแฟ 60";
            else {
              const user = await getUser(userId);
              let tx = await enrichWithAi({ id: crypto.randomUUID(), type: "expense", category: categoryFor(receipt.merchant), description: receipt.merchant, amount: receipt.amount, createdAt: new Date().toISOString() }, receipt.merchant);
              tx = { ...tx, authorId, authorName: await getGroupMemberName(userId, authorId) };
              user.transactions.push(tx); await saveUser(userId, user);
              message = txFlexMessage(tx, { budget: budgetProgressFor(user, tx), dashboardUrl: dashboardEditUrl(userId) });
            }
          } catch (error) { console.error("Receipt read failed", error.message); message = "ระบบประมวลผลภาพใช้เวลานานกว่าปกติ กรุณาลองใหม่อีกครั้ง"; }
        }
      } catch (error) { console.error("Group image handling failed", error.message); message = "ระบบประมวลผลภาพใช้เวลานานกว่าปกติ กรุณาลองใหม่อีกครั้ง"; }
      try { await (typeof message === "string" ? reply(event.replyToken, message) : replyMessages(event.replyToken, [message])); } catch (error) { console.error("Could not reply", error.message); }
      continue;
    }
    if (event.message?.type === "image") {
      // 1:1 เดิม: รูปภาพอาจเป็น "สลิปการชำระเงิน Premium" (ถ้ามี upload_session ค้างรออยู่) หรือ "ใบเสร็จ" (ฟีเจอร์ Premium)
      // การตัดสินใจว่าเป็นแบบไหน และการตรวจสิทธิ์ Premium เกิดที่ backend เสมอ ไม่เชื่อ Rich Menu ที่ผู้ใช้กดมา (spec §16)
      let message;
      try {
        const routing = await subLineHandlers.handleReceiptOrSlipImage(userId, () => downloadLineImage(event.message.id));
        if (routing.type === "slip") {
          message = routing.message;
        } else if (routing.type === "premium_denied") {
          message = routing.message;
        } else {
          // routing.type === "receipt" && routing.isPremium === true -> ฟีเจอร์เดิม: อ่านใบเสร็จบันทึกบัญชี
          if (!ai || !visionModel) message = "ยังไม่ได้ตั้งค่าโมเดล AI แบบอ่านรูปภาพ (ตั้งค่า OPENAI_VISION_MODEL หรือ OPENAI_MODEL ที่รองรับรูปภาพใน .env) ตอนนี้พิมพ์รายการแทนได้ก่อน เช่น กาแฟ 60";
          else {
            try {
              const { mime, base64 } = await downloadLineImage(event.message.id);
              const receipt = await readReceipt(mime, base64);
              if (!receipt) message = "อ่านยอดเงินจากใบเสร็จนี้ไม่ได้ ลองถ่ายให้เห็นยอดรวมชัด ๆ อีกครั้ง หรือพิมพ์รายการเองแทนได้ เช่น กาแฟ 60";
              else {
                const user = await getUser(userId);
                const tx = await enrichWithAi({ id: crypto.randomUUID(), type: "expense", category: categoryFor(receipt.merchant), description: receipt.merchant, amount: receipt.amount, createdAt: new Date().toISOString() }, receipt.merchant);
                user.transactions.push(tx); await saveUser(userId, user);
                message = txFlexMessage(tx, { budget: budgetProgressFor(user, tx), dashboardUrl: dashboardEditUrl(userId) });
              }
            } catch (error) { console.error("Receipt read failed", error.message); message = "ระบบประมวลผลภาพใช้เวลานานกว่าปกติ กรุณาลองใหม่อีกครั้ง"; }
          }
        }
      } catch (error) { console.error("Image handling failed", error.message); message = "ระบบประมวลผลภาพใช้เวลานานกว่าปกติ กรุณาลองใหม่อีกครั้ง"; }
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
          message = "✅ ยืนยันสำเร็จ กลุ่มนี้ปลดล็อกฟีเจอร์ Premium แล้ว (ใช้ได้เฉพาะในกลุ่มนี้เท่านั้น)\n\nทุกคำสั่งต้องขึ้นต้นด้วย \"/บอท\" เสมอ เช่น \"/บอท กาแฟ 60\"";
        } else if (result.reason === "NOT_PREMIUM") {
          message = "บัญชีของคุณยังไม่ใช่ Premium ยายจันทร์ขอตัวออกจากกลุ่มนี้นะคะ 🙏\nถ้าอยากใช้งานฟีเจอร์นี้ ต้องสมัคร Premium แบบส่วนตัวกับยายจันทร์ก่อน (แชท 1:1 พิมพ์ \"สมัครพรีเมียม\")";
          try { await reply(event.replyToken, message); } catch (error) { console.error("Could not reply", error.message); }
          try { await leaveGroup(userId); await groupLinkService.markLeft(userId); } catch (error) { console.error("Leaving group after rejection failed:", error.message); }
          continue;
        } else if (result.reason === "EXPIRED") {
          message = "หมดเวลายืนยันแล้ว ยายจันทร์ขอตัวออกจากกลุ่มนี้นะคะ 🙏 เชิญเข้ามาใหม่ได้เลยถ้าต้องการลองอีกครั้ง";
          try { await reply(event.replyToken, message); } catch (error) { console.error("Could not reply", error.message); }
          try { await leaveGroup(userId); await groupLinkService.markLeft(userId); } catch (error) { console.error("Leaving group after expiry failed:", error.message); }
          continue;
        } else {
          message = "กลุ่มนี้ยืนยันเจ้าของไปแล้ว หรือไม่มีคำขอที่รอยืนยันอยู่";
        }
      } catch (error) { console.error("Confirm owner failed", error.message); message = "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง"; }
      try { await reply(event.replyToken, message); } catch (error) { console.error("Could not reply", error.message); }
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
      try { await reply(event.replyToken, "สมัคร Premium ทำได้เฉพาะแชทส่วนตัวกับยายจันทร์เท่านั้นนะ ไปคุย 1:1 แล้วพิมพ์ \"สมัครพรีเมียม\" ได้เลย\n\nพอสมัครเสร็จแล้ว เชิญยายจันทร์เข้ากลุ่มนี้ (หรือกลุ่มอื่น) แล้วพิมพ์ \"/บอท ยืนยันเจ้าของ\" เพื่อปลดล็อก Premium ให้ทั้งกลุ่มได้เลย"); } catch (error) { console.error("Could not reply", error.message); }
      continue;
    }
    if (!isGroupChat && text === "ส่งสลิป") {
      let message;
      try { message = await subLineHandlers.handleSendSlipCommand(userId); }
      catch (error) { console.error("Send-slip command failed", error.message); message = "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง"; }
      try { await reply(event.replyToken, message); } catch (error) { console.error("Could not reply", error.message); }
      continue;
    }
    // ในกลุ่ม "/บอท สลิป" ใช้แค่เพื่อ "รอรับรูปใบเสร็จ" มาจดรายจ่ายกองกลาง (ต้องเป็นกลุ่ม Premium อยู่แล้วเท่านั้น)
    // คนละเรื่องกับ "ส่งสลิป" แบบ 1:1 ที่ผูกกับ payment_session ตอนสมัคร Premium — ในกลุ่มไม่มี payment_session ให้ผูก
    // จึงใช้ groupLinkService.openReceiptWait/consumeReceiptWait แทน uploadSessionService โดยสิ้นเชิง
    if (isGroupChat && text === "สลิป") {
      let message;
      try {
        const isPremiumGroup = await groupLinkService.isPremiumGroup(userId);
        if (!isPremiumGroup) message = "กลุ่มนี้ยังไม่ได้ปลดล็อก Premium นะ (ต้องมีสมาชิก Premium เป็นเจ้าของกลุ่ม)\nไปสมัคร Premium แบบ 1:1 กับยายจันทร์ก่อน แล้วเชิญเข้ากลุ่มพร้อมพิมพ์ \"/บอท ยืนยันเจ้าของ\"";
        else { await groupLinkService.openReceiptWait(userId, authorId); message = "กรุณาส่งรูปใบเสร็จตามมาได้เลย 🧾"; }
      } catch (error) { console.error("Group slip command failed", error.message); message = "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง"; }
      try { await reply(event.replyToken, message); } catch (error) { console.error("Could not reply", error.message); }
      continue;
    }

    // --- ความจำต่อคน (ไม่ใช่ต่อบัญชี/กลุ่ม): แยกจากกองกลาง แต่ละคนมีความจำของตัวเองเสมอแม้อยู่กลุ่มเดียวกัน ---
    // personId ใช้ authorId เสมอ (เท่ากับ userId อยู่แล้วในแชท 1:1 เพราะ authorId = event.source.userId ทุกกรณี)
    const personId = authorId ?? userId;
    if (text.startsWith("จำไว้ว่า")) {
      const factText = text.slice("จำไว้ว่า".length).replace(/^[:\s]+/, "").trim();
      let message;
      if (!factText) message = "พิมพ์ต่อท้ายด้วยว่าอยากให้จำอะไร เช่น \"จำไว้ว่า ฉันชื่อกอล์ฟ\"";
      else {
        try { await memoryService.addFact(personId, factText, "explicit"); message = `จำไว้แล้วนะ: ${factText}`; }
        catch (error) { console.error("Add fact failed", error.message); message = "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง"; }
      }
      try { await reply(event.replyToken, message); } catch (error) { console.error("Could not reply", error.message); }
      continue;
    }
    if (text === "ดูสิ่งที่จำ" || text === "ความจำ") {
      let message;
      try {
        const mem = await memoryService.getMemory(personId);
        message = (!mem.name && mem.facts.length === 0)
          ? "ยายจันทร์ยังไม่ได้จำอะไรเกี่ยวกับคุณไว้เลยนะ ลองพิมพ์ \"จำไว้ว่า ...\" ดูได้"
          : `📝 สิ่งที่จำไว้เกี่ยวกับคุณ:\n${mem.name ? `ชื่อ: ${mem.name}\n` : ""}${mem.facts.map((f) => `• ${f.text}`).join("\n")}`;
      } catch (error) { console.error("Get memory failed", error.message); message = "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง"; }
      try { await reply(event.replyToken, message); } catch (error) { console.error("Could not reply", error.message); }
      continue;
    }
    if (text === "ลบความจำ") {
      let message;
      try { await memoryService.clearAll(personId); message = "ลบความจำเกี่ยวกับคุณเรียบร้อยแล้วนะ"; }
      catch (error) { console.error("Clear memory failed", error.message); message = "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง"; }
      try { await reply(event.replyToken, message); } catch (error) { console.error("Could not reply", error.message); }
      continue;
    }

    const user = await getUser(userId);
    if (applyRecurring(user)) await saveUser(userId, user);
    let message;
    const helpText = isGroupChat
      ? "📒 ยายจันทร์พร้อมจดบัญชีกองกลางให้กลุ่มนี้\n\nทุกคำสั่งต้องขึ้นต้นด้วย \"/บอท\" เสมอ เช่น:\n/บอท กาแฟ 60\n/บอท เงินเดือน 15000\n/บอท สลิป (แล้วส่งรูปใบเสร็จตาม — ต้องมีสมาชิก Premium เป็นเจ้าของกลุ่มนี้ก่อน)\n/บอท สรุปวันนี้ | /บอท สรุปเดือนนี้ | /บอท ลบล่าสุด | /บอท เว็บ\n/บอท จำไว้ว่า ... | /บอท ดูสิ่งที่จำ | /บอท ลบความจำ (ความจำเป็นของแต่ละคน ไม่ปนกับคนอื่นในกลุ่ม)\n\nสมัคร Premium ต้องไปแชท 1:1 กับยายจันทร์เท่านั้น"
      : "📒 ยายจันทร์พร้อมจดบัญชีของคุณ (ข้อมูลของแต่ละคนแยกกันเป็นส่วนตัว)\n\nพิมพ์: กาแฟ 60\nรายรับ: เงินเดือน 15000\nถ่ายรูปใบเสร็จส่งมาได้เลย (ฟีเจอร์ Premium) ยายจันทร์จะอ่านยอดกับร้านค้าให้อัตโนมัติ\nคำสั่ง: สรุปวันนี้ | สรุปเดือนนี้ | ลบล่าสุด | เว็บ | สมัครพรีเมียม | จำไว้ว่า ... | ดูสิ่งที่จำ | ลบความจำ\nทุกวันอาทิตย์ยายจันทร์จะสรุปสัปดาห์ให้อัตโนมัติด้วย\n\nหรือถามยายจันทร์ได้เลย เช่น \"เดือนนี้ใช้เงินไปกับอะไรมากสุด\" ยายจันทร์เน้นตอบเรื่องการเงินเป็นหลัก แต่คุยเรื่องอื่นได้ด้วย และจำเรื่องที่คุณเล่าไว้คุยครั้งหน้าได้ด้วยนะ";
    if (["เริ่ม", "ช่วยเหลือ", "help"].includes(text.toLowerCase())) message = helpText;
    else if (text === "สรุปวันนี้") message = summary(user.transactions.filter((tx) => sameDay(tx.createdAt)), "วันนี้");
    else if (text === "สรุปเดือนนี้") { const month = user.transactions.filter((tx) => sameMonth(tx.createdAt)); message = `${summary(month, "เดือนนี้")}\n\n${advice(month)}`; }
    else if (text === "ลบล่าสุด") { const tx = user.transactions.pop(); if (tx) { await saveUser(userId, user); message = `ลบแล้ว: ${tx.description} ${money(tx.amount)} บาท`; } else message = "ยังไม่มีรายการให้ลบ"; }
    else if (text === "เว็บ") { const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, ""); message = base ? `📊 แดชบอร์ด${isGroupChat ? "กองกลางของกลุ่มนี้" : "ส่วนตัวของคุณ"}\n${base}/dashboard?token=${perUserToken(userId)}&u=${encodeURIComponent(userId)}` : "ยังไม่ได้ตั้งค่า PUBLIC_BASE_URL สำหรับแดชบอร์ด"; }
    else {
      let tx = parse(text);
      if (tx) {
        const ambiguous = tx._typeAmbiguous; delete tx._typeAmbiguous;
        tx = await enrichWithAi(tx, text, ambiguous);
        if (isGroupChat) tx = { ...tx, authorId, authorName: await getGroupMemberName(userId, authorId) };
        user.transactions.push(tx); await saveUser(userId, user);
        message = txFlexMessage(tx, { budget: budgetProgressFor(user, tx), dashboardUrl: dashboardEditUrl(userId) });
      }
      else {
        const mem = await memoryService.getMemory(personId);
        const aiAnswer = await askFinanceAi(user, text, memoryService.buildContextLine(mem));
        message = aiAnswer ?? (isGroupChat ? "พิมพ์ได้เลย เช่น /บอท กาแฟ 60 หรือ /บอท เงินเดือน 15000\nพิมพ์ /บอท ช่วยเหลือ เพื่อดูคำสั่ง" : "พิมพ์ได้เลย เช่น กาแฟ 60 หรือ เงินเดือน 15000\nพิมพ์ ช่วยเหลือ เพื่อดูคำสั่ง");
        // ดึงข้อมูลที่ควรจำแบบเงียบ ๆ ในพื้นหลัง ไม่บล็อกการตอบกลับผู้ใช้ ผิดพลาดก็แค่ log ไม่กระทบผู้ใช้
        extractMemoryFromText(ai, process.env.OPENAI_MODEL, text)
          .then(async ({ name, facts }) => {
            if (name) await memoryService.setName(personId, name);
            for (const fact of facts) await memoryService.addFact(personId, fact, "auto");
          })
          .catch((error) => console.warn("Memory auto-extraction failed:", error.message));
      }
    }
    try { await (typeof message === "string" ? reply(event.replyToken, message) : replyMessages(event.replyToken, [message])); } catch (error) { console.error("Could not reply", error.message); }
  }
});
app.listen(Number(process.env.PORT ?? 3000), () => console.log(`Ta Phin listening on ${process.env.PORT ?? 3000}`));

