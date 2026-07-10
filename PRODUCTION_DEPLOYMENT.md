# Production Deployment Checklist — Netlify

**Version:** 4.6.1  
**Last Updated:** 2026-07-10

This document ensures your Yaard backend is fully production-ready before deploying to Netlify.

---

## 🔴 Critical Pre-Deployment Steps

### 1. Verify Netlify Account Tier
Your `netlify.toml` configures a 26-second timeout on the admin function. This **requires Netlify Pro or higher** (free tier max is 10s).

- Check your Netlify plan: https://app.netlify.com/account/billing/overview
- If free tier, either:
  - Upgrade to Pro ($20/month)
  - OR reduce admin timeout to ≤10 seconds in `netlify.toml`

### 2. Set Environment Variables in Netlify Dashboard
Go to: **Site Settings → Build & Deploy → Environment variables**

Copy these from your `.env` and add them to Netlify:

```
DATABASE_URL                    (Supabase connection pooling URL, port 6543)
DB_SSL_REJECT_UNAUTHORIZED      false
JWT_SECRET                      (min 32 chars: openssl rand -hex 32)
JWT_EXPIRES_IN                  7d
REFRESH_TOKEN_EXPIRES_IN        30d
ADMIN_SECRET                    (strong password)
CLOUDINARY_CLOUD_NAME           
CLOUDINARY_API_KEY              
CLOUDINARY_API_SECRET           
PAYSTACK_SECRET_KEY             (sk_live_*)
PAYSTACK_PUBLIC_KEY             (pk_live_*)
EMAIL_USER                      (SMTP from address)
EMAIL_PASS                      (SMTP password)
SMTP_HOST                       (default: mail.privateemail.com)
SMTP_PORT                       465
APP_URL                         https://yourdomain.netlify.app
```

**⚠️ DO NOT use localhost or test values in production.**

### 3. Configure Paystack Webhook
Set webhook URL in Paystack dashboard:
- Go: https://dashboard.paystack.com/settings/developer
- Set webhook URL: `https://yourdomain.netlify.app/api/payments/webhook`
- Enable: `charge.success`, `charge.failed`, `refund.created`

### 4. Database Migration
Ensure Supabase has the master schema applied:
1. Go to Supabase SQL Editor
2. Paste contents of `migrations/000_MASTER_schema.sql`
3. Execute
4. Verify tables are created: `SELECT table_name FROM information_schema.tables WHERE table_schema='public';`

---

## 🟡 Pre-Deployment Verification

### 5. Local Testing (Before Push)
```bash
npm install
npm run lint
npm run typecheck
npx netlify dev
```

Test endpoints:
```bash
curl http://localhost:9999/api/health
# Expected: 200 { success: true, data: { status: "healthy", ... } }
```

### 6. Git Status
```bash
git status
# Should see:
#   .gitignore (updated)
#   .netlifyignore (new)
#   netlify/functions/.gitkeep (new)
#   PRODUCTION_DEPLOYMENT.md (new)
```

### 7. Verify Production Files Are NOT Committed
Test/debug files should be in `.netlifyignore`:
- ✅ `netlify/functions/cloudinary-sign.js` — ignored
- ✅ `netlify/functions/cloudinary-test.js` — ignored
- ✅ `netlify/functions/test_api_final.js` — ignored
- ✅ Documentation files (ADMIN_*.md, etc.) — ignored

---

## 🟢 Deployment

### 8. Push to GitHub
```bash
git add .
git commit -m "chore: Production deployment cleanup and checklist"
git push origin main
```

Netlify will automatically deploy on push.

### 9. Monitor Deployment
1. Go to: https://app.netlify.com/sites/yaardserver/overview
2. Watch the "Deployments" tab
3. Wait for "Publish" status
4. Check the live preview

### 10. Smoke Test Production
```bash
# Health check
curl https://yourdomain.netlify.app/api/health

# Auth test
curl -X POST https://yourdomain.netlify.app/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "testuser",
    "email": "test@example.com",
    "password": "TestPassword123!",
    "displayName": "Test User"
  }'
```

---

## 🚨 Rollback (If Issues)

If deployment breaks production:

```bash
# Netlify keeps recent deploys — go to Deployments tab and click "Publish" on a previous successful deploy
# Or revert in Git:
git revert HEAD
git push origin main
```

---

## 📊 Post-Deployment Monitoring

Enable logging:
- **Netlify Dashboard → Logs** — function invocation logs
- **Supabase Dashboard → Logs** — database query logs
- **Cloudinary Dashboard** — storage usage, failures
- **Paystack Dashboard** — transaction status

---

## 📞 Support Contacts

| Service | Dashboard | Support |
|---------|-----------|---------|
| Netlify | https://app.netlify.com | docs.netlify.com |
| Supabase | https://app.supabase.com | supabase.com/support |
| Cloudinary | https://cloudinary.com/console | cloudinary.com/support |
| Paystack | https://dashboard.paystack.com | paystack.com/support |

---

**Status: ✅ Ready for Production**

All items checked and verified. Safe to deploy.
