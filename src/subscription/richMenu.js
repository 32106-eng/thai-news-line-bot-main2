// Rich Menu เป็นแค่ UI สะดวกในการกดปุ่ม — "ไม่ใช่" ระบบ Security (spec §16, §33)
// ทุก action ที่ผู้ใช้กดจาก Rich Menu ต้องผ่านการตรวจสอบสิทธิ์จาก backend เหมือนกับ
// ถ้าผู้ใช้พิมพ์ข้อความเองหรือยิง request ตรง ๆ โดยไม่ผ่าน Rich Menu เลย
//
// โมดูลนี้จัดการแค่การ "สลับภาพเมนู" ให้ตรงกับแพ็กเกจปัจจุบัน เพื่อ UX ที่ดีเท่านั้น
// การสร้าง/อัปโหลดภาพ Rich Menu จริงต้องทำผ่าน LINE Messaging API (rich menu image upload)
// ซึ่งต้องใช้ asset รูปภาพจริง — ในโค้ดนี้เตรียม logic การ "ผูก/สลับ" rich menu ID ที่มีอยู่แล้ว
// (คุณต้องสร้าง Rich Menu 2 อัน — Free กับ Premium — ผ่าน LINE console หรือ Messaging API ก่อน
// แล้วนำ richMenuId มาใส่ใน .env: LINE_RICH_MENU_FREE_ID, LINE_RICH_MENU_PREMIUM_ID)

async function callLineApi(endpoint, options) {
  const r = await fetch(`https://api.line.me${endpoint}`, {
    ...options,
    headers: { ...options?.headers, authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
  });
  if (!r.ok) throw new Error(`LINE rich menu API ${endpoint}: ${r.status}`);
  return r;
}

export function createRichMenuService() {
  const freeMenuId = process.env.LINE_RICH_MENU_FREE_ID;
  const premiumMenuId = process.env.LINE_RICH_MENU_PREMIUM_ID;

  async function switchTo(userId, plan) {
    const menuId = plan === "PREMIUM" ? premiumMenuId : freeMenuId;
    if (!menuId) {
      console.warn(`Rich menu for plan=${plan} is not configured (set LINE_RICH_MENU_${plan}_ID in .env) — skipping menu switch`);
      return false;
    }
    try {
      await callLineApi(`/v2/bot/user/${userId}/richmenu/${menuId}`, { method: "POST" });
      return true;
    } catch (error) {
      console.error("Rich menu switch failed:", error.message);
      return false;
    }
  }

  return { switchTo };
}
