# ตาผิน Premium — Architecture & Security Design

สถานะ: เอกสารออกแบบก่อนเขียนโค้ด (ตามคำสั่ง "ห้ามเขียน Code ทันที")

## 0. บริบทของการรวมระบบ (Integration Context)

โปรเจกต์เดิม `pa-nuan-line-ledger` เป็นบอทบันทึกบัญชีส่วนตัวบน LINE ใช้:
- Firestore (ไม่ใช่ SQL) เก็บข้อมูลผู้ใช้ 1 document ต่อคน (`panuan_users/{lineUserId}`)
- Express + webhook เดียวจาก LINE
- ฟีเจอร์ "ถ่ายรูปใบเสร็จ" (vision AI อ่านใบเสร็จ) คือฟีเจอร์ประมวลผลภาพเดียวในระบบ → **นี่คือฟีเจอร์ที่จะถูกกันไว้เฉพาะ Premium**
- Dashboard token เดิมใช้ HMAC ต่อ user (ไม่มีระบบ Admin)

ระบบ subscription นี้จะ**เพิ่มเข้าไป**ในโค้ดเดิม ไม่ใช่โปรเจกต์แยก โดย:
- ใช้ Firestore เดิม เพิ่ม collections ใหม่ (ตาม §5)
- Firestore ไม่มี UNIQUE constraint แบบ SQL — เราจำลองด้วย **document ID = ค่าที่ต้องการ unique** (เช่น doc ID ของ transaction = transaction_reference) ร่วมกับ Firestore transaction (`runTransaction`) เพื่อให้ atomic check-then-write ปลอดภัยจาก race condition
- ไม่มี payment provider จริงต่ออยู่ (ไม่มี API key/บัญชีให้เชื่อมในสภาพแวดล้อมนี้) → **ทุก slip ที่ผ่าน OCR จะเข้า `PENDING_REVIEW` เสมอ ไม่มี auto-approve เด็ดขาด** ระบบเตรียม adapter interface (`PaymentProvider`) ไว้ให้เสียบ provider จริงภายหลัง (PromptPay slip-verify API, Omise, 2C2P ฯลฯ) — เมื่อเสียบแล้วค่อยเปิด auto-verify ได้ โดยไม่ต้องแก้ flow หลัก

## 1. Architecture ที่แนะนำ

```
                     ┌─────────────────────┐
                     │   LINE Platform      │
                     │ (Webhook, Messaging  │
                     │  API, Rich Menu)     │
                     └──────────┬───────────┘
                                │ HTTPS + HMAC signature
                                ▼
                     ┌─────────────────────┐
                     │   Express App        │
                     │  (single Node proc)  │
                     ├─────────────────────┤
                     │ /webhook              │ ← LINE events
                     │ /webhook/payment       │ ← Payment provider webhook (future)
                     │ /api/* (dashboard)      │ ← user dashboard (existing)
                     │ /admin/* (new)          │ ← admin dashboard, session-auth
                     └──────────┬───────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌───────────────┐     ┌────────────────┐      ┌──────────────────┐
│ Subscription    │     │ Payment Engine   │      │ Vision/OCR (AI)   │
│ Service          │     │ (state machine)  │      │ existing OpenAI/  │
│ - isPremium()    │     │ - session mgmt    │      │ OpenRouter client │
│ - activate()      │     │ - QR generation    │      │ (extract only,    │
│ - expire()         │     │ - verify()          │      │ never approves)   │
└────────┬────────┘     └────────┬─────────┘      └──────────────────┘
         │                        │
         └───────────┬────────────┘
                      ▼
             ┌─────────────────┐
             │   Firestore       │
             │  (collections     │
             │   in §5)          │
             └─────────────────┘
```

หลักการ:
- **Single source of truth = Firestore**, ไม่เชื่อค่าจาก client/LINE message text ว่าเป็น "จ่ายแล้ว"
- **Authorization check เกิดที่ backend ทุกครั้ง** ก่อนเรียกฟีเจอร์ Premium (ไม่ใช่ที่ Rich Menu)
- **Payment verification แยกชั้นจาก OCR** — OCR เป็นแค่ตัวช่วยอ่าน ไม่ใช่ตัวอนุมัติ
- Cron (`node-cron`, มีอยู่แล้วในโปรเจกต์) ใช้เสริมสำหรับ mark expired subscriptions ให้ dashboard/reporting ดูง่าย แต่ **ไม่ใช่ตัวเดียวที่ป้องกันการใช้งานหลังหมดอายุ** — ทุก request เช็ค `expires_at` สดจาก DB เสมอ (§10, §13 ของ spec)

## 2. Security Weaknesses ที่ต้องป้องกัน (Threat Model)

| # | ช่องโหว่ | ผลกระทบ | การป้องกัน |
|---|---|---|---|
| T1 | ผู้ใช้แก้ไขรูปสลิป (Photoshop ยอดเงิน/เวลา) | เปิด Premium ฟรี | ไม่ auto-approve จาก OCR อย่างเดียว → ต้องผ่าน provider verification หรือ PENDING_REVIEW + admin |
| T2 | Replay: ส่งสลิปเดิมซ้ำหลายครั้ง/หลาย user | เปิด Premium ซ้ำจาก 1 การจ่ายจริง | `transaction_reference` เป็น doc ID ที่ unique โดยธรรมชาติใน Firestore, เขียนแบบ `create()` (fail ถ้ามีอยู่แล้ว) |
| T3 | Double-submit: กดสมัคร/ส่งสลิปพร้อมกันหลายครั้ง (double-tap, retry) | สร้าง session/subscription ซ้ำ | Idempotency key ต่อ session, Firestore `runTransaction` สำหรับ check-then-write, unique doc ID กัน race |
| T4 | User A ใช้สลิปของ User B | User A ได้ Premium โดยไม่จ่าย | ผูก payment_session ↔ user_id ↔ upload_session ↔ transaction ตลอด chain, เช็คทุกจุด |
| T5 | Session เก่าถูกเอากลับมาใช้ (เช่น QR หมดอายุ) | จ่ายเงินไม่ตรงรอบ/สร้างความสับสน | `expires_at` บน payment_session และ upload_session, เช็คก่อนใช้งานทุกครั้ง |
| T6 | Client ส่ง `premium=true` / แก้ local storage / แก้ JWT เอง | Bypass การจ่ายเงิน | Backend ไม่เชื่อ client state ใด ๆ, โหลด subscription จาก DB ทุก request |
| T7 | Webhook ปลอม (ถ้ามี payment webhook ในอนาคต) | อนุมัติ payment เท็จ | ตรวจ signature + secret เสมอ, เก็บ `webhook_events` กัน replay/duplicate |
| T8 | Rich Menu ไม่สะท้อนสิทธิ์จริง (user เก่าเก็บ rich menu Premium ไว้หลังหมดอายุ) | ดูเหมือนใช้ได้แต่จริง ๆ ไม่ควร | Rich Menu เป็นแค่ UI, ทุก action เช็ค subscription จาก backend เสมอ ไม่ใช่จาก rich menu ที่กด |
| T9 | Admin endpoint ไม่มี auth / ใช้ query param `?admin=true` | ใครก็ approve payment ได้ | Session-based admin auth (username+password hash + signed cookie), เช็คสิทธิ์ทุก request |
| T10 | Secret หลุดใน source/log (เคยเกิดขึ้นแล้วกับโปรเจกต์นี้ – ดู README เดิม) | Credential compromise | .env เท่านั้น, logging ไม่พิมพ์ secret, เตือนใน README เดิมให้ rotate |
| T11 | Race condition: 2 requests ตรวจสอบ subscription status พร้อมกันตอนจะ activate | Subscription ถูกสร้างซ้ำ / expires_at ผิด | ใช้ Firestore `runTransaction` ครอบ read-check-write ของ activate/renew |
| T12 | Image API (OpenAI/OpenRouter) timeout/error ทำระบบ hang หรือ crash | UX พัง, อาจ DoS ตัวเอง | try/catch รอบทุก call, ข้อความ fallback ภาษาไทย, log error, ไม่ throw ขึ้นไปกระทบ webhook handler อื่น |

## 3. Payment Flow (State Machine)

```
CREATED → WAITING_PAYMENT → PAYMENT_DETECTED(optional) → VERIFYING → VERIFIED → PREMIUM_ACTIVATED
                                                              │
                                                              ├──→ PENDING_REVIEW → (admin) → VERIFIED / REJECTED
                                                              └──→ REJECTED

payment_session แยกจาก payment_transaction:
- payment_session: เปิดตอนพิมพ์ "สมัครพรีเมียม" อายุ 20 นาที status ใน {WAITING_PAYMENT, CONSUMED, EXPIRED}
- payment_transaction: สร้างตอน "ส่งสลิป" มาถึง มี transaction_reference (unique) status ใน
  {VERIFYING, PENDING_REVIEW, VERIFIED, REJECTED, DUPLICATE}
```

เหตุผลที่แยก 2 entity: payment_session คือ "เจตนาจะจ่าย" (สร้างได้หลายครั้งถ้าหมดอายุ/ยกเลิก) ส่วน payment_transaction คือ "หลักฐานการจ่ายที่ระบบพยายามตรวจสอบแล้ว" (unique ต่อ 1 transaction_reference จริง) — ไม่ผูกรวมกันเพื่อไม่ให้ 1 unique-constraint ต้องรับภาระ 2 concept

## 4. Subscription Renewal Logic

ตาม spec ข้อ 14: ต่ออายุแบบ `current_expiry + 1 month` ถ้ายังไม่หมดอายุ, หรือ `now + 1 month` ถ้าหมดอายุไปแล้ว/ไม่เคยมี:

```
newExpiry = (subscription.status === ACTIVE && subscription.expires_at > now)
  ? addMonths(subscription.expires_at, 1)
  : addMonths(now, 1)
```

ทั้งหมดคำนวณด้วย server time, timezone `Asia/Bangkok` สำหรับการแสดงผลเท่านั้น (เก็บ timestamp เป็น UTC ISO ใน DB ตามปกติ Firestore Timestamp, แปลงตอนแสดงผล)

## 5. Database Design (Firestore Collections)

Firestore ไม่มี FK/UNIQUE ระดับ engine — จำลองด้วย:
- **doc ID = natural unique key** เมื่อทำได้ (บังคับ uniqueness โดยธรรมชาติ เพราะสร้างซ้ำ ID เดียวกันไม่ได้ด้วย `create()`)
- **`runTransaction`** สำหรับทุก read-check-write ที่ต้อง atomic

| Collection | Doc ID | Fields | Uniqueness |
|---|---|---|---|
| `panuan_users` | `{lineUserId}` | (มีอยู่แล้ว) transactions, recurring, budgets | line_user_id = doc ID เอง |
| `subscriptions` | `{lineUserId}` | plan, status, started_at, expires_at, payment_transaction_id, updated_at | 1 doc ต่อ user (ไม่ต้อง array ประวัติ — เก็บ current เท่านั้น, ประวัติอยู่ใน audit_logs) |
| `payment_sessions` | auto-id | user_id, reference_id, amount, currency, status, expires_at, created_at, updated_at | `reference_id` เป็น field ที่ unique โดย generate แบบสุ่ม 100% ชนไม่ได้ในทางปฏิบัติ (crypto random) |
| `payment_transactions` | **`{transaction_reference}`** | user_id, payment_session_id, amount, status, paid_at, verified_at, created_at, updated_at, ocr_extracted (raw OCR data แยกจาก verified data) | doc ID = transaction_reference → ใช้ `create()` กันซ้ำ100% |
| `upload_sessions` | auto-id | user_id, payment_session_id, status, expires_at, created_at, updated_at | ผูก 1:1 กับ payment_session ที่ active |
| `webhook_events` | **`{provider}_{event_id}`** | provider, event_type, payload_hash, status, created_at, processed_at | doc ID รวม provider+event_id → กัน replay ข้าม provider |
| `audit_logs` | auto-id | user_id, event_type, payment_session_id, transaction_reference, metadata, created_at | append-only, ไม่ unique constraint (เป็น log) |
| `admins` | `{adminUsername}` | password_hash, role, created_at | username = doc ID |

**ER Diagram (แนวคิด)**
```
users(1) ──< subscriptions(1)     [1 current subscription per user, doc keyed by user id]
users(1) ──< payment_sessions(N)
payment_sessions(1) ──< upload_sessions(N, ปกติ 1 active)
payment_sessions(1) ──< payment_transactions(N ในทางทฤษฎี, แต่ปกติ 1 สำเร็จ)
payment_transactions(1) ──> subscriptions(1)   [subscription.payment_transaction_id]
users(1) ──< audit_logs(N)
admins(1) ──< audit_logs(N) [เมื่อ admin action]
```

## 6. API Endpoint Design

### LINE Webhook (ของเดิม ขยาย logic)
- `POST /webhook` — เพิ่ม text command "สมัครพรีเมียม", "ส่งสลิป" และ gate รูปภาพใบเสร็จด้วย `isPremium()`

### Payment Provider Webhook (โครงไว้สำหรับอนาคต ยังไม่มี provider จริง)
- `POST /webhook/payment` — ตรวจ signature, บันทึก `webhook_events`, กัน replay. ปัจจุบันไม่มี provider ต่อจริง จึงยังไม่ mount route นี้ (เอกสารไว้สำหรับตอนเสียบ provider)

### Admin (ใหม่, ต้อง auth)
- `POST /admin/login` — form login → signed cookie session
- `POST /admin/logout`
- `GET /admin` — dashboard HTML (ต้อง login)
- `GET /admin/api/overview` — สรุปตัวเลข (users, premium, payments, security) ตาม §23
- `GET /admin/api/reviews` — รายการ PENDING_REVIEW
- `POST /admin/api/reviews/:transactionRef/approve`
- `POST /admin/api/reviews/:transactionRef/reject`
- `GET /admin/api/audit-logs`

ทุก endpoint ใน `/admin/*` (ยกเว้น `/admin/login`) เช็ค session cookie → โหลด admin จาก DB → เช็ค role ก่อนทำงาน

## 7. Folder Structure

```
pa-nuan-line-ledger/
├── package.json
├── .env / .env.example
├── .gitignore
└── src/
    ├── index.js              # entry: mount webhook + dashboard + admin routes (เดิม + ใหม่)
    ├── dashboard.html        # เดิม (user dashboard)
    ├── subscription/
    │   ├── db.js             # Firestore collection refs + generic helpers
    │   ├── users.js          # (ของเดิมย้ายมา หรือ cross-ref ป้านวล user)
    │   ├── subscriptions.js  # isPremium(), activate(), renew(), expire()
    │   ├── paymentSessions.js
    │   ├── paymentTransactions.js
    │   ├── uploadSessions.js
    │   ├── ocr.js            # อ่านสลิปด้วย vision AI (extract only)
    │   ├── paymentProvider.js# adapter interface + stub (PENDING_REVIEW เสมอ)
    │   ├── qr.js             # สร้าง QR (PromptPay-style payload) ตาม reference
    │   ├── auditLog.js
    │   ├── richMenu.js       # LINE rich menu switch free/premium
    │   └── lineHandlers.js   # ข้อความ/รูป ที่เกี่ยวกับ premium flow
    ├── admin/
    │   ├── auth.js           # login/session/cookie signing
    │   ├── routes.js         # /admin/* express router
    │   └── dashboard.html    # admin UI
    └── shared/
        └── time.js           # Asia/Bangkok helpers (ของเดิมมีบางส่วนแล้วใน index.js)
```

## 8. Testing Plan

ตาราง test case (ตาม spec §39) — จะ implement เป็น Node's built-in `node:test` + Firestore emulator หรือ manual test script เพราะไม่มี network ใน sandbox นี้สำหรับรัน emulator จริง จะเตรียม script ทดสอบ pure-logic (state machine, renewal date calc, idempotency helpers) แบบ unit ที่รันได้โดยไม่ต้องต่อ Firestore จริง แล้วให้ผู้ใช้รัน integration test กับ Firestore จริงเอง

| Case | วิธีทดสอบ |
|---|---|
| สมัคร Premium (Free→session ใหม่) | unit: `subscriptions.requestUpgrade()` คืน session ใหม่เมื่อ user เป็น Free |
| สมัครซ้ำตอนเป็น Premium อยู่แล้ว | unit: คืนสถานะปัจจุบัน ไม่สร้าง session ใหม่ |
| ส่งสลิปถูกต้อง → PENDING_REVIEW (ไม่มี provider) | unit: mock OCR, assert status = PENDING_REVIEW เสมอ |
| ส่งสลิปซ้ำ (เดิม transaction_reference) | unit: `create()` ครั้งที่ 2 ต้อง reject ด้วย DUPLICATE |
| ส่งสลิปของคนอื่น (session ไม่ตรง user) | unit: upload_session.user_id ≠ request user → reject |
| Payment session หมดอายุ | unit: expires_at < now → reject ก่อนสร้าง upload_session |
| Premium หมดอายุ | unit: expires_at ผ่านไปแล้ว → isPremium() = false แม้ status ยังเป็น ACTIVE ใน DB |
| ต่ออายุก่อนหมดอายุ | unit: newExpiry = เดิม + 1 เดือน |
| ต่ออายุหลังหมดอายุ | unit: newExpiry = now + 1 เดือน |
| กดสมัครซ้ำพร้อมกัน (double submit) | unit: idempotency key กันสร้าง session ซ้ำในช่วงเวลาใกล้กัน |
| ส่งสลิปพร้อมกัน 5 ครั้ง | unit: mock Firestore `create()` ให้ throw ตั้งแต่ครั้งที่ 2 |
| Free เรียก Premium API (รูปภาพ) | unit: `isPremium()=false` → handler ตอบปฏิเสธ ไม่เรียก vision AI |
| Premium หมดอายุเรียก Premium API | unit: เหมือนข้างบนแต่ expires_at ผ่านแล้ว |
| Admin approve/reject | unit: เปลี่ยน status + เรียก activate() เฉพาะตอน approve |
| Admin ไม่มีสิทธิ์ | unit: route ปฏิเสธถ้าไม่มี session cookie ที่ valid |
| Webhook ปลอม/ซ้ำ (โครงไว้) | unit: signature ผิด → 401, event_id ซ้ำ → skip processing |
| API ภาพ timeout/error | unit: mock ai client throw → handler ตอบข้อความ fallback ไม่ throw ต่อ |

---
เอกสารนี้ครอบคลุม §37 ข้อ 1–9 ตามที่ร้องขอ (Architecture, ER, Payment Flow, Threat model รวมและแยก, DB Schema, API Design, Folder Structure, Testing Plan) ต่อไปจะเริ่มพัฒนาโค้ดตามลำดับ Phase 1–12
