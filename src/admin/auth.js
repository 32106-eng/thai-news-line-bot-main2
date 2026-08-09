// Admin auth: session cookie ลงนามด้วย ADMIN_SESSION_SECRET (HMAC), เก็บ admin username ใน DB
// ห้ามใช้ ?admin=true หรือ client-side flag ใด ๆ เป็นตัวกำหนดสิทธิ์ (spec §25)
// ทุก request เข้า /admin/* (ยกเว้น /admin/login) ต้องผ่าน requireAdmin() middleware นี้

import crypto from "node:crypto";

const COOKIE_NAME = "panuan_admin_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 ชั่วโมง

function sign(value) {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error("Missing ADMIN_SESSION_SECRET. Add it to .env.");
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

export function verifyPassword(password, storedHash, salt) {
  const candidate = hashPassword(password, salt);
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: hashPassword(password, salt) };
}

function makeSessionToken(username) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = `${username}.${expiresAt}`;
  const signature = sign(payload);
  return `${Buffer.from(payload).toString("base64url")}.${signature}`;
}

function parseSessionToken(token) {
  if (!token || typeof token !== "string") return null;
  const [payloadB64, signature] = token.split(".");
  if (!payloadB64 || !signature) return null;
  let payload;
  try { payload = Buffer.from(payloadB64, "base64url").toString("utf8"); } catch { return null; }
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [username, expiresAtStr] = payload.split(".");
  const expiresAt = Number(expiresAtStr);
  if (!username || !Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  return { username };
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

export function createAdminAuth({ admins }) {
  async function login(username, password) {
    const snap = await admins.doc(String(username)).get();
    if (!snap.exists) return { ok: false };
    const data = snap.data();
    if (!verifyPassword(password, data.passwordHash, data.passwordSalt)) return { ok: false };
    return { ok: true, token: makeSessionToken(username), role: data.role ?? "admin" };
  }

  function setSessionCookie(res, token) {
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: SESSION_TTL_MS
    });
  }

  function clearSessionCookie(res) {
    res.clearCookie(COOKIE_NAME);
  }

  /** Express middleware: ปฏิเสธถ้าไม่มี session cookie ที่ valid ผูกกับ admin จริงใน DB */
  function requireAdmin() {
    return async (req, res, next) => {
      const token = readCookie(req, COOKIE_NAME);
      const parsed = parseSessionToken(token);
      if (!parsed) return res.status(401).json({ error: "ต้องเข้าสู่ระบบผู้ดูแล" });
      const snap = await admins.doc(parsed.username).get();
      if (!snap.exists) return res.status(401).json({ error: "ต้องเข้าสู่ระบบผู้ดูแล" });
      req.admin = { username: parsed.username, role: snap.data().role ?? "admin" };
      next();
    };
  }

  return { login, setSessionCookie, clearSessionCookie, requireAdmin };
}
