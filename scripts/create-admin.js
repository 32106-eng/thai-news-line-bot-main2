// สร้าง/รีเซ็ตบัญชี Admin สำหรับ Admin Dashboard
// รันด้วยมือเท่านั้น (ไม่มี self-registration ใน UI ตาม spec §25):
//   node scripts/create-admin.js <username> <password> [role]
//
// ต้องตั้งค่า FIREBASE_SERVICE_ACCOUNT ใน .env ก่อนรัน (เหมือนที่ index.js ใช้)

import "dotenv/config";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createPasswordRecord } from "../src/admin/auth.js";

const [, , username, password, role = "admin"] = process.argv;

if (!username || !password) {
  console.error("Usage: node scripts/create-admin.js <username> <password> [role]");
  process.exit(1);
}
if (password.length < 10) {
  console.error("รหัสผ่านควรมีความยาวอย่างน้อย 10 ตัวอักษร");
  process.exit(1);
}
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("Missing FIREBASE_SERVICE_ACCOUNT in .env");
  process.exit(1);
}

const app = initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const admins = getFirestore(app).collection("panuan_admins");

const { salt, hash } = createPasswordRecord(password);
await admins.doc(username).set({
  passwordHash: hash,
  passwordSalt: salt,
  role,
  createdAt: new Date()
});

console.log(`สร้าง/อัปเดตบัญชี admin "${username}" (role: ${role}) เรียบร้อย`);
process.exit(0);
