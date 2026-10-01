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

/** เที่ยงคืนของ "วันนี้" ตามเวลา Asia/Bangkok (UTC+7 คงที่ ไม่มี DST) — ใช้เทียบกับ Firestore Timestamp ตรง ๆ ได้ (ดู tokenUsage.js) */
export function startOfTodayBangkok(reference = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: BANGKOK_TZ, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(reference)
      .map(({ type, value }) => [type, value])
  );
  return new Date(`${p.year}-${p.month}-${p.day}T00:00:00+07:00`);
}

/** เที่ยงคืนวันจันทร์ของสัปดาห์นี้ตามเวลา Asia/Bangkok (สัปดาห์เริ่มวันจันทร์) */
export function startOfWeekBangkok(reference = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: BANGKOK_TZ, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(reference)
      .map(({ type, value }) => [type, value])
  );
  // หา day-of-week จากปี-เดือน-วันตามเวลาไทยตรง ๆ ผ่าน Date.UTC (day-of-week เป็นฟังก์ชันของปฏิทินล้วน ๆ ไม่ขึ้นกับ timezone ที่ใช้คำนวณ)
  // ห้ามเอา getUTCDay() จาก Date ที่มี offset +07:00 มาใช้ตรง ๆ เพราะเที่ยงคืนไทยคือ 17:00 UTC ของ "วันก่อนหน้า" เสมอ จะได้ day-of-week เพี้ยนไปวันนึง
  const asUtcMidnight = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
  const dayOfWeek = new Date(asUtcMidnight).getUTCDay(); // 0=อาทิตย์...6=เสาร์ ของวันที่ตามปฏิทินไทย
  const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const monday = new Date(asUtcMidnight - diffToMonday * 86_400_000);
  const my = monday.getUTCFullYear();
  const mm = String(monday.getUTCMonth() + 1).padStart(2, "0");
  const md = String(monday.getUTCDate()).padStart(2, "0");
  return new Date(`${my}-${mm}-${md}T00:00:00+07:00`);
}
