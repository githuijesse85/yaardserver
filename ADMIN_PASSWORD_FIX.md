# Admin Panel Login Fix - Password Configuration

**Issue:** Admin panel password not working (ADMIN_PASSWORD environment variable not set)

---

## Quick Fix (Choose One)

### Option 1: Set via Netlify UI (Recommended)

1. Go to: https://app.netlify.com/sites/yaardserver
2. Click: **Site Settings** → **Build & deploy** → **Environment**
3. Click: **Edit variables**
4. Add new variable:
   ```
   Key: ADMIN_PASSWORD
   Value: your_secure_password_here
   ```
5. Click: **Save**
6. Redeploy: Go to **Deploys** → **Trigger deploy** → **Deploy site**

### Option 2: Set via Netlify CLI

```bash
netlify env:set ADMIN_PASSWORD "your_secure_password_here"
```

Then redeploy:
```bash
netlify deploy --prod
```

### Option 3: Set via git (Not recommended for secrets, but for testing)

Create/update `.env` in root:
```
ADMIN_PASSWORD=your_secure_password_here
```

Then:
```bash
netlify deploy --prod
```

---

## Verify Configuration

Check if environment variable is set:

```bash
curl https://yaardserver.netlify.app/api/admin/diag
```

Response should be:
```json
{
  "ADMIN_PASSWORD_SET": true,
  "JWT_SECRET_SET": true,
  "timestamp": "2026-05-22T...",
  "message": "All systems operational"
}
```

If you see `"ADMIN_PASSWORD_SET": false`, the variable is not set.

---

## Test Login

Once configured:

```bash
curl -X POST https://yaardserver.netlify.app/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"password":"your_secure_password_here"}'
```

Expected response (JWT):
```json
{
  "token": "<JWT token signed with JWT_SECRET>"
}
```

---

## Troubleshooting

### Still getting "Invalid admin password"?
- Double-check the password you set matches what you're entering
- Spaces/special characters? Make sure they're exactly the same
- If changed recently, wait 2-3 minutes for cache to clear
- Try: **Netlify Dashboard** → **Deploys** → **Clear cache and redeploy**

### Getting "Password not configured"?
- The `ADMIN_PASSWORD` environment variable wasn't found
- Follow "Quick Fix" section above
- Restart browser after setting variable

### 503 Error?
- Admin system not properly configured
- Set the ADMIN_PASSWORD environment variable
- Redeploy the site

---

## Environment Variables Summary

| Variable | Purpose | Required | Set |
|----------|---------|----------|-----|
| `ADMIN_PASSWORD` | Admin panel password | ✅ Yes | ❌ No |
| `JWT_SECRET` | Auth token secret | ✅ Yes | ? |
| `DATABASE_URL` | Supabase connection | ✅ Yes | ? |
| `REDIS_URL` | Redis cache connection | ⚠️ Optional | ? |
| `PAYSTACK_SECRET_KEY` | Payments | ✅ Yes | ? |

---

## Production Best Practices

1. **Use strong passwords**: At least 16 characters with symbols
2. **Rotate regularly**: Change admin password every 90 days
3. **Use environment variables**: Never hardcode secrets
4. **Limit access**: Only share password with authorized admins
5. **Monitor access**: Check admin logs regularly

---

## Quick Start Summary

```
1. Set ADMIN_PASSWORD in Netlify
2. Redeploy site
3. Wait 1-2 minutes
4. Try login again
5. Check /api/admin/diag endpoint
```

---

**Status:** After setting the environment variable and redeploying, admin login should work immediately.
