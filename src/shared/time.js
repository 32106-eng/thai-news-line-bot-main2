// ทุกฟังก์ชันในไฟล์นี้ใช้เวลาจาก Server เท่านั้น (new Date()) ห้ามรับเวลาจาก client มาคำนวณ
// วันหมดอายุ/สถานะการชำระเงินใด ๆ — Client ส่งได้แค่ "ข้อมูล" ไม่ใช่ "เวลา" ที่ระบบเชื่อ

export const BANGKOK_TZ = "Asia/Bangkok";

/** เวลาปัจจุบันของ server (UTC internally, แสดงผลเป็น Bangkok เมื่อ format เท่านั้น) */
export function now() {
  return new Date();
}

/** เพิ่มจำนวนเดือนแบบปฏิทิน (รักษาวันที่ให้ใกล้เคียงที่สุด เช่น 31 ม.ค. + 1 เดือน = 28/29 ก.พ.) */
export function addMonths(date, months) {
  const d = new Date(date instanceof Date ? date.getTime() : new Date(date).getTime());
  const day = d.getDate();
  d.setDate(1); // กันปัญหา overflow วันที่ตอนเปลี่ยนเดือน
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

export function addMinutes(date, minutes) {
  return new Date((date instanceof Date ? date.getTime() : new Date(date).getTime()) + minutes * 60_000);
}

export function isExpired(date) {
  if (!date) return true;
  const value = date instanceof Date ? date : new Date(date);
  return Number.isNaN(value.getTime()) || value.getTime() <= Date.now();
}

export function formatThaiDateTime(date) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return "-";
  return new Intl.DateTimeFormat("th-TH", {
    timeZone: BANGKOK_TZ,
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(value);
}

export function formatThaiDate(date) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return "-";
  return new Intl.DateTimeFormat("th-TH", { timeZone: BANGKOK_TZ, day: "numeric", month: "long", year: "numeric" }).format(value);
}

/** จำนวนวันที่เหลือ (ปัดขึ้น) นับจากตอนนี้ถึง date ที่ให้มา ไม่ติดลบ */
export function daysRemaining(date) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return 0;
  return Math.max(0, Math.ceil((value.getTime() - Date.now()) / 86_400_000));
}
