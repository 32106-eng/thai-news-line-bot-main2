import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toDate } from "../subscription/db.js";
import { SUB_STATUS } from "../subscription/subscriptions.js";
import { SESSION_STATUS } from "../subscription/paymentSessions.js";
import { TX_STATUS } from "../subscription/paymentTransactions.js";
import { formatThaiDateTime } from "../shared/time.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createAdminRouter({ collections, adminAuth, subscriptionService, paymentTransactionService }) {
  const router = express.Router();
  const dashboardHtmlPromise = fs.readFile(path.join(__dirname, "dashboard.html"), "utf8");

  router.post("/login", express.json(), async (req, res) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) return res.status(400).json({ error: "กรุณากรอกชื่อผู้ใช้และรหัสผ่าน" });
    const result = await adminAuth.login(String(username), String(password));
    if (!result.ok) return res.status(401).json({ error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
    adminAuth.setSessionCookie(res, result.token);
    res.json({ ok: true });
  });

  router.post("/logout", (req, res) => {
    adminAuth.clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get("/", async (req, res) => {
    res.type("html").send(await dashboardHtmlPromise);
  });

  const requireAdmin = adminAuth.requireAdmin();

  router.get("/api/overview", requireAdmin, async (_req, res) => {
    const [usersSnap, subsSnap, sessionsSnap, txSnap] = await Promise.all([
      collections.subscriptions.get(), // proxy for "has a subscription doc" — combined w/ users below for total count if needed
      collections.subscriptions.get(),
      collections.paymentSessions.get(),
      collections.paymentTransactions.get()
    ]);
    void usersSnap;

    let premiumActive = 0, premiumExpired = 0, premiumNearExpiry = 0;
    const soon = Date.now() + 3 * 86_400_000;
    for (const doc of subsSnap.docs) {
      const data = doc.data();
      const expiresAt = toDate(data.expiresAt);
      const isActive = data.status === SUB_STATUS.ACTIVE && expiresAt && expiresAt.getTime() > Date.now();
      if (isActive) {
        premiumActive += 1;
        if (expiresAt.getTime() <= soon) premiumNearExpiry += 1;
      } else if (data.status === SUB_STATUS.EXPIRED) {
        premiumExpired += 1;
      }
    }

    const paymentCounts = { WAITING_PAYMENT: 0 };
    for (const doc of sessionsSnap.docs) {
      const status = doc.data().status;
      paymentCounts[status] = (paymentCounts[status] ?? 0) + 1;
    }
    const txCounts = {};
    let duplicateCount = 0;
    for (const doc of txSnap.docs) {
      const status = doc.data().status;
      txCounts[status] = (txCounts[status] ?? 0) + 1;
      if (status === TX_STATUS.DUPLICATE) duplicateCount += 1;
    }

    res.json({
      users: { premiumActive, premiumExpired, premiumNearExpiry },
      payments: {
        waiting: paymentCounts[SESSION_STATUS.WAITING_PAYMENT] ?? 0,
        verifying: txCounts[TX_STATUS.VERIFYING] ?? 0,
        verified: txCounts[TX_STATUS.VERIFIED] ?? 0,
        pendingReview: txCounts[TX_STATUS.PENDING_REVIEW] ?? 0,
        rejected: txCounts[TX_STATUS.REJECTED] ?? 0
      },
      security: {
        duplicateTransactions: duplicateCount
      }
    });
  });

  router.get("/api/reviews", requireAdmin, async (_req, res) => {
    const list = await paymentTransactionService.listPendingReview();
    res.json({
      reviews: list.map((item) => ({
        transactionReference: item.transactionReference,
        userId: item.userId,
        amount: item.amount,
        reviewReason: item.reviewReason,
        ocrExtracted: item.ocrExtracted,
        createdAt: item.createdAt ? formatThaiDateTime(item.createdAt) : null
      }))
    });
  });

  router.post("/api/reviews/:transactionReference/approve", requireAdmin, async (req, res) => {
    const result = await paymentTransactionService.adminApprove({ transactionReference: req.params.transactionReference, adminUsername: req.admin.username });
    if (!result.ok) return res.status(409).json({ error: result.reason ?? "ไม่สามารถอนุมัติได้" });
    res.json({ ok: true });
  });

  router.post("/api/reviews/:transactionReference/reject", requireAdmin, express.json(), async (req, res) => {
    const result = await paymentTransactionService.adminReject({ transactionReference: req.params.transactionReference, adminUsername: req.admin.username, reason: req.body?.reason ?? "manual_reject" });
    if (!result.ok) return res.status(409).json({ error: result.reason ?? "ไม่สามารถปฏิเสธได้" });
    res.json({ ok: true });
  });

  // ดึงชื่อโปรไฟล์ LINE ของ user (ใช้ userId 1:1 เท่านั้น ไม่ใช่ groupId — กลุ่มไม่มี subscription เป็นของตัวเอง)
  // ถ้าดึงไม่ได้ (เช่น user บล็อกบอทไปแล้ว) จะได้ null กลับมา ฝั่งหน้าเว็บ fallback ไปโชว์ userId แทน
  async function getLineDisplayName(userId) {
    try {
      const r = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, { headers: { authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` } });
      if (!r.ok) return null;
      const profile = await r.json();
      return profile.displayName ?? null;
    } catch { return null; }
  }

  // รายชื่อ Premium ทั้งหมดที่ active อยู่ตอนนี้ (เรียงหมดอายุเร็วสุดก่อน) พร้อมชื่อ LINE จริง ไม่ใช่แค่ userId
  // ใช้แทนการต้องพิมพ์ userId เดาเองในฟอร์ม "ยกเลิก Premium ของ User" เดิม — ตอนนี้กดยกเลิกจากรายการได้เลย
  router.get("/api/premium-users", requireAdmin, async (_req, res) => {
    const snap = await collections.subscriptions.where("status", "==", SUB_STATUS.ACTIVE).get();
    const now = Date.now();
    const active = snap.docs
      .map((doc) => ({ userId: doc.id, expiresAt: toDate(doc.data().expiresAt), startedAt: toDate(doc.data().startedAt) }))
      .filter((u) => u.expiresAt && u.expiresAt.getTime() > now)
      .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
    const withNames = await Promise.all(active.map(async (u) => ({
      ...u,
      displayName: await getLineDisplayName(u.userId),
      expiresAt: formatThaiDateTime(u.expiresAt),
      startedAt: u.startedAt ? formatThaiDateTime(u.startedAt) : null
    })));
    res.json({ users: withNames });
  });

  // ค้นหา user ตาม LINE userId ตรง ๆ เพื่อดูสถานะ Premium ก่อนยกเลิก
  router.get("/api/users/:userId", requireAdmin, async (req, res) => {
    const sub = await subscriptionService.getStatusView(req.params.userId);
    res.json({
      userId: req.params.userId,
      plan: sub.plan,
      active: sub.active,
      startedAt: sub.startedAt ? formatThaiDateTime(sub.startedAt) : null,
      expiresAt: sub.expiresAt ? formatThaiDateTime(sub.expiresAt) : null
    });
  });

  // แอดมินยกเลิก Premium ของ user คนใดก็ได้ทันที (spec: admin can cancel other users' premium)
  router.post("/api/users/:userId/cancel-premium", requireAdmin, express.json(), async (req, res) => {
    const result = await subscriptionService.adminCancel({
      userId: req.params.userId,
      adminUsername: req.admin.username,
      reason: req.body?.reason ?? null
    });
    if (!result.ok) return res.status(409).json({ error: result.reason ?? "ไม่สามารถยกเลิกได้" });
    res.json({ ok: true });
  });

  router.get("/api/audit-logs", requireAdmin, async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const snap = await collections.auditLogs.orderBy("createdAt", "desc").limit(limit).get();
    res.json({
      logs: snap.docs.map((doc) => {
        const data = doc.data();
        return { ...data, createdAt: data.createdAt ? formatThaiDateTime(toDate(data.createdAt)) : null };
      })
    });
  });

  return router;
}

