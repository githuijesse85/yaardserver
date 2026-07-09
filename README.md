# Yaard API — Netlify Serverless Backend

Version **4.6.1** · Node.js 20 · PostgreSQL (Supabase) · Cloudinary · Paystack

---

## Quick Start

### 1. Clone & Install

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Key variables:
| Variable | Description |
|---|---|
| `DATABASE_URL` | Supabase connection pooling URL (port 6543) |
| `DB_SSL_REJECT_UNAUTHORIZED` | Set to `false` for Supabase |
| `JWT_SECRET` | Min 32-char random string (`openssl rand -hex 32`) |
| `CLOUDINARY_CLOUD_NAME` | Your Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Your Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Your Cloudinary API secret |
| `PAYSTACK_SECRET_KEY` | Paystack live secret key |
| `EMAIL_USER` | SMTP from address |
| `EMAIL_PASS` | SMTP password |
| `SMTP_HOST` | SMTP server (default: `mail.privateemail.com`) |
| `SMTP_PORT` | SMTP port (default: `465`) |
| `APP_URL` | Your Netlify site URL |

### 3. Set Up Database

Run the master schema on a fresh Supabase database:

```sql
-- In Supabase SQL Editor, paste the contents of:
migrations/000_MASTER_schema.sql
```

Or for an existing database, run migrations 001–013 in order.

### 4. Local Development

```bash
npx netlify dev
```

### 5. Deploy to Netlify

Push to GitHub → Netlify auto-deploys.

Set all environment variables in:  
**Netlify → Site settings → Build & deploy → Environment variables**

---

## Architecture

```
netlify/functions/     ← Serverless function handlers (one per domain)
shared/                ← Shared modules (db, middleware, cloudinary, email, paystack)
migrations/            ← SQL migrations (000_MASTER is cumulative)
public/                ← Static assets served at site root
system-config.json     ← App version / feature flags
netlify.toml           ← Netlify routing + build config
```

### API Routes

| Path | Function | Auth |
|---|---|---|
| `GET /api/health` | `health.js` | None |
| `POST /api/auth/register` | `auth.js` | None |
| `POST /api/auth/login` | `auth.js` | None |
| `POST /api/auth/refresh` | `auth.js` | None |
| `POST /api/auth/forgot-password` | `auth.js` | None |
| `POST /api/auth/reset-password` | `auth.js` | None |
| `GET /api/users/me` | `users.js` | Required |
| `PUT /api/users/me` | `users.js` | Required |
| `GET /api/users/:username` | `users.js` | Optional |
| `GET /api/feed` | `feed.js` | Optional |
| `GET /api/feed/following` | `feed.js` | Required |
| `GET /api/feed/categories` | `feed.js` | None |
| `GET /api/videos` | `videos.js` | Optional |
| `POST /api/videos` | `videos.js` | Required |
| `GET /api/videos/upload-signature` | `videos.js` | Required |
| `GET /api/videos/:id` | `videos.js` | Optional |
| `POST /api/images/upload-signature` | `images.js` | Required |
| `POST /api/images/upload-complete` | `images.js` | Required |
| `GET /api/comments/video/:videoId` | `comments.js` | Optional |
| `POST /api/comments` | `comments.js` | Required |
| `GET /api/notifications` | `notifications.js` | Required |
| `POST /api/ads` | `ads.js` | Required |
| `GET /api/payments` | `payments.js` | Required |
| `POST /api/payments/webhook` | `payments.js` | Paystack HMAC |
| `GET /api/music` | `music.js` | None |
| `GET /api/search` | `search.js` | Optional |
| `GET /api/system/config` | `system.js` | None |

---

## Bug Fixes in This Release

### Image Upload Signature — `images.js`

**Problem:** The old `/api/images/upload-signature` route called `validateImageRequest()` which required `fileName` and `fileSize` in the request body. The Android app (`ImageUploadSignatureRequest`) only sends `{ imageType, resourceType }`, so every signature request returned HTTP 400 — no signature was ever issued — and every image upload failed at the Cloudinary API with "Unauthorized".

**Fix:** Removed `validateImageRequest()` from the signature route. File metadata validation now happens at `/api/images/upload-complete` (after the upload), which is the correct place. The signature route now only requires `imageType` (one of: `avatar`, `cover`, `thumbnail`).

### Cloudinary Signature `max_bytes` — `shared/cloudinary.js`

**Problem:** The `generateUploadSignature()` function was including `max_bytes` and/or `max_file_size` in the HMAC-signed parameter set. Cloudinary validates the signature by re-computing the HMAC over exactly the parameters the client sends in the multipart upload. The Android Cloudinary SDK does not echo `max_bytes` back, so the signatures didn't match → HTTP 401 from Cloudinary.

**Fix:** `max_bytes` and `max_file_size` are now stripped from the params before signing. Enforce upload size limits via Cloudinary Upload Presets or at the `/upload-complete` endpoint instead.

---

## Shared Modules

| Module | Purpose |
|---|---|
| `shared/db.js` | PostgreSQL pool (singleton, reused across warm invocations) |
| `shared/middleware.js` | CORS, JWT auth, JSON response helpers, body parsing |
| `shared/cloudinary.js` | Upload signature generation, streaming URL derivation, upload/delete helpers |
| `shared/email.js` | Nodemailer SMTP — verification, password reset, admin alerts |
| `shared/paystack.js` | Paystack transaction init, verify, webhook validation, refund |
| `shared/env.js` | dotenv loader (dev only; Netlify injects vars in production) |

---

## Database

- **Provider:** Supabase (PostgreSQL 15)
- **Connection:** Use the **connection pooling** URL (port `6543`, transaction mode)
- **SSL:** Set `DB_SSL_REJECT_UNAUTHORIZED=false` for Supabase's self-signed cert
- **Schema:** See `migrations/000_MASTER_schema.sql` for the full cumulative schema

---

## Cloudinary Setup

1. Create a free Cloudinary account at [cloudinary.com](https://cloudinary.com)
2. Copy your **Cloud name**, **API key**, and **API secret** from the dashboard
3. (Recommended) Create an **Upload Preset** with:
   - Mode: Unsigned
   - Max file size: 100MB for videos, 10MB for images
   - Folder: `yaard/`

---

## Paystack Setup

1. Create a Paystack account at [paystack.com](https://paystack.com)
2. Copy your **Secret key** from Settings → API Keys
3. Set webhook URL in Paystack dashboard: `https://your-site.netlify.app/api/payments/webhook`
