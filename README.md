# ป้านวล — LINE Ledger Bot (+ Premium Subscription)

## ระบบ Premium (ใหม่)

บอทมี 2 แพ็กเกจ: **Free** (ใช้บันทึกบัญชีด้วยข้อความได้ปกติ) และ **Premium** (50 บาท/เดือน, ปลดล็อกฟีเจอร์ถ่ายรูปใบเสร็จ)
เอกสารสถาปัตยกรรมฉบับเต็มอยู่ที่ `docs/ARCHITECTURE.md`

**สำคัญที่สุด**: ระบบนี้**ยังไม่ได้เชื่อมกับ Payment Provider จริง** ที่ตรวจสอบธุรกรรมได้ (ไม่มี PromptPay
slip-verification API / Omise / 2C2P ฯลฯ ต่ออยู่) ดังนั้น **ทุกสลิปที่ส่งเข้ามาจะเข้าสถานะ
`PENDING_REVIEW` เสมอ** — Admin ต้องเข้า `/admin` เพื่ออนุมัติ/ปฏิเสธเองทุกรายการ นี่คือ fallback
ที่ปลอดภัยตามที่ออกแบบไว้ตั้งแต่แรก ไม่ใช่บั๊ก ดูวิธีเสียบ provider จริงใน
`src/subscription/paymentProvider.js`

### Setup

```bash
npm install
cp .env.example .env   # ใส่ค่าเดิมให้ครบ + ค่าใหม่ด้านล่าง

# ตั้งค่าใหม่ที่ต้องมี:
#   ADMIN_SESSION_SECRET   -> สุ่มค่ายาว ๆ เช่น: openssl rand -hex 32
#   PROMPTPAY_ID            -> เบอร์/เลขบัตร ปชช. บัญชีรับเงิน (ถ้ายังไม่มี ระบบจะไม่ออก QR ให้)
#   LINE_RICH_MENU_FREE_ID / LINE_RICH_MENU_PREMIUM_ID -> สร้าง Rich Menu 2 อันใน LINE Console ก่อน (ไม่บังคับ ถ้าไม่ตั้งจะข้ามการสลับเมนู)
#   LIFF_ID                 -> ต้องมีเพื่อให้ปุ่ม "สรุป" และ "หมวด/งบ" บน Rich Menu เปิดเว็บได้ทันทีในคลิกเดียว (ดูวิธีสร้างด้านล่าง)

npm run create-admin -- <username> <password>   # สร้างบัญชี admin คนแรก (รหัสผ่าน ≥10 ตัวอักษร)
npm start
```

เข้า Admin Dashboard ที่ `<PUBLIC_BASE_URL>/admin`

### ตั้งค่า LIFF (สำหรับปุ่ม "สรุป" / "หมวด/งบ" บน Rich Menu)

Rich Menu เป็นรูปภาพเดียวที่ผู้ใช้ทุกคนเห็นร่วมกัน ปุ่มบนนั้นจึงผูก URL คงที่ตัวเดียว ไม่รู้ว่าใครเป็นคนกด
วิธีเดียวที่ทำให้กดแล้ว **เปิดเว็บของคนนั้นได้ทันทีในคลิกเดียว** (ไม่ต้องผ่านการ์ดข้อความที่มีปุ่มให้กดซ้ำ)
คือใช้ LIFF ซึ่งรันอยู่ในตัวเปิดแอปของ LINE เอง จึงรู้ว่าใครเปิดอยู่โดยอัตโนมัติ

1. เข้า [LINE Developers Console](https://developers.line.biz/console/) เลือก Provider/Channel เดียวกับที่ใช้ทำบอทนี้
2. ไปแท็บ **LIFF** → **Add**
3. ตั้งค่า:
   - **Endpoint URL**: `<PUBLIC_BASE_URL>/liff-redirect`
   - **Size**: Full (แนะนำ จะได้เต็มจอ)
   - **Scope**: ติ๊ก `profile` (ต้องมี เพื่อดึง userId)
4. กด Add แล้วคัดลอกค่า **LIFF ID** ที่ได้ (รูปแบบ `1234567890-AbCdEfGh`)
5. นำไปใส่ใน `.env`: `LIFF_ID=1234567890-AbCdEfGh`
6. รัน `node scripts/setup-rich-menu.js` อีกครั้งเพื่ออัปเดตปุ่มบน Rich Menu ให้ใช้ URL ใหม่นี้

ถ้ายังไม่ตั้งค่า `LIFF_ID` ปุ่ม "สรุป"/"หมวด/งบ" จะเปิดหน้าแจ้งเตือนแทนแดชบอร์ดจริง — ฟีเจอร์อื่นทั้งหมดยังใช้งานได้ปกติ

### คำสั่งใหม่บน LINE
- **`สมัครพรีเมียม`** — เริ่ม/ดูสถานะการสมัคร Premium
- **`ส่งสลิป`** — เปิดรับรูปสลิปหลังชำระเงิน (ต้องพิมพ์ "สมัครพรีเมียม" ก่อน)
- ส่งรูปสลิปหลังจากนั้น → ระบบตรวจสอบ → เข้าคิว `PENDING_REVIEW` ให้ Admin อนุมัติ

### Test
```bash
npm test   # unit test ของ subscription/payment logic (ไม่ต้องต่อ Firestore จริง)
```

---


## โครงสร้างไฟล์ (สำคัญมาก ต้องตรงนี้)
```
pa-nuan-line-ledger/
├── package.json
├── .env              <- สร้างเองจาก .env.example (ห้าม commit)
├── .gitignore
├── data/             <- ระบบสร้างให้อัตโนมัติตอนรัน
└── src/
    ├── index.js
    └── dashboard.html   <- ต้องอยู่ในโฟลเดอร์เดียวกับ index.js เท่านั้น
```
`index.js` อ่าน `dashboard.html` ด้วย `fs.readFile(path.join(__dirname, "dashboard.html"))`
ถ้าวางไฟล์นี้ผิดที่ (เช่นไว้ที่ root) โปรแกรมจะ crash ตั้งแต่ตอนเริ่ม (top-level await)
และ platform จะตอบ 503 ให้ LINE เหมือนที่คุณเจอ

## ติดตั้งและรัน
```bash
npm install
cp .env.example .env   # แล้วใส่ค่าใน .env ให้ครบ
npm start              # หรือ npm run dev สำหรับ auto-reload
```

## ทำไมถึงเจอ 503 ตอน Verify Webhook
1. **ขาด environment variables** — `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN`
   ไม่ถูกตั้งบนเซิร์ฟเวอร์จริง (ไฟล์ .env ไม่ถูก push เพราะอยู่ใน .gitignore)
   → โค้ด throw ตั้งแต่บรรทัดแรก → process ไม่เคยไปถึง `app.listen()`
2. **`dashboard.html` วางผิดตำแหน่ง** — ต้องอยู่ใน `src/` เดียวกับ `index.js`
3. **PUBLIC_BASE_URL เป็น `loca.lt` (localtunnel)** — ใช้ได้เฉพาะตอนรันเครื่องตัวเองและ
   ตัว tunnel client (เช่น `npx localtunnel`) ยังทำงานอยู่เท่านั้น ถ้าเครื่องหลับ ปิด terminal
   หรือ tunnel session หมดอายุ เว็บฮุคจะเข้าไม่ถึงทันที และ LINE จะได้ 503/timeout
   → **สำหรับใช้งานจริง แนะนำ deploy ขึ้น host ถาวร** (Render, Railway, Fly.io) แทน localtunnel
   แล้วอัปเดต Webhook URL ในหน้า LINE Developers Console ให้เป็นโดเมนถาวรนั้น

## ⚠️ สำคัญ: หมุนกุญแจ (rotate credentials) ทันที
ไฟล์ `.env` ที่คุณอัปโหลดมามีค่าจริงของ:
- LINE Channel access token
- OpenRouter API key
- Dashboard token

ค่าพวกนี้ตอนนี้ถูกวางไว้ในบทสนทนานี้แล้ว **แนะนำให้ไปออกคีย์ใหม่ทุกตัวทันที** ก่อนใช้งานจริง:
- LINE: Developers Console > Channel > Messaging API > Issue ใหม่ (และลบ token เก่า)
- OpenRouter: ไปหน้า API Keys แล้วลบคีย์เก่า ออกคีย์ใหม่
- Dashboard token: ตั้งค่าสุ่มใหม่เองในไฟล์ .env

จากนั้นใส่ค่าคีย์ใหม่ลงใน `.env` (ไฟล์นี้ไม่รวมอยู่ในแพ็กเกจที่ดาวน์โหลด เพื่อความปลอดภัย
ให้ใช้ `.env.example` เป็นต้นแบบ)
