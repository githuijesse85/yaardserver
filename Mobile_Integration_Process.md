# Mobile Integration Process

This document describes the full mobile integration process for Yaard:
- session management and authentication
- direct Cloudinary media uploads
- ad creation workflow

---

## 1. Authentication & Session Management

### 1.1 Overview

The mobile app authenticates against the Netlify Functions backend using JWT tokens.
Two token types are issued:
- `accessToken` — usable for authenticated API requests
- `refreshToken` — usable only with `/api/auth/refresh` to get a new access token

The backend enforces strict access-token validation and rejects any token whose JWT payload `type` is not `access`.
This prevents refresh tokens from being used as access credentials.

### 1.2 Register Flow

1. User submits registration data to:
   - `POST /api/auth/register`
2. Required body fields:
   - `email`
   - `username`
   - `password`
   - `displayName` (optional, defaults to username)
   - `phone` (optional)
3. Backend validates the request, hashes the password, and creates a user record.
4. A verification token is generated and stored in the `users` table with a 24-hour expiry.
5. The backend sends the verification email asynchronously.
6. Response includes:
   - `user`
   - `accessToken`
   - `refreshToken`
   - `token` (alias for accessToken for compatibility)

### 1.3 Login Flow

1. User submits credentials to:
   - `POST /api/auth/login`
2. Request body:
   - `emailOrUsername`
   - `password`
3. Backend looks up the user by email or username and validates the password.
4. If authentication succeeds, it returns:
   - `user`
   - `accessToken`
   - `refreshToken`
   - `token`

### 1.4 Email Verification

1. The verification link from email calls:
   - `GET /api/auth/verify-email?token={verification_token}`
2. If the token is valid and within 24 hours, the account is marked verified.
3. The token and expiry are cleared from the database.

### 1.5 Resend Verification

1. If the user does not verify in time, the mobile app can request:
   - `POST /api/auth/resend-verification`
2. Request body:
   - `email`
3. The backend behaves safely by:
   - returning the same generic success message regardless of whether the user exists
   - reusing an unexpired token if present
   - generating a new token only when needed

### 1.6 Token Refresh

1. When the access token expires, refresh it using:
   - `POST /api/auth/refresh`
2. Request body:
   - `refreshToken`
3. Backend verifies the refresh token and ensures its JWT type is `refresh`.
4. If valid, it issues a new pair of tokens:
   - `accessToken`
   - `refreshToken`
   - `token`

### 1.7 Protected Requests

All protected mobile requests must include the authorization header:

```http
Authorization: Bearer {accessToken}
```

The backend validates this token via `shared/middleware.js`:
- extracts the bearer token
- checks `JWT_SECRET`
- verifies the JWT signature
- checks expiration
- requires `payload.type === "access"`
- returns authenticated payload as `event.user`

### 1.8 Session Hardening Notes

- `accessToken` is the only valid credential for route protection.
- `refreshToken` is only accepted by `/api/auth/refresh`.
- If the authorization header is missing or invalid, the request fails with 401.
- All authenticated routes should use `requireAuth(event)` to retrieve `userId`.

---

## 2. Mobile Auth Process (Recommended Sequence)

### 2.1 New User Registration

1. App submits `POST /api/auth/register`.
2. Store `accessToken` and `refreshToken` securely on the device.
3. Prompt the user to verify email if `is_verified` is false.
4. Use the same `accessToken` for immediate authenticated actions if allowed.

### 2.2 Returning User Login

1. App submits `POST /api/auth/login`.
2. Store tokens securely.
3. If the account is not verified, the app can offer `resend-verification`.

### 2.3 Silent Token Renewal

1. Detect access token expiry client-side.
2. Call `POST /api/auth/refresh` with the stored `refreshToken`.
3. Replace stored tokens with the newly returned values.
4. Retry the original request after refresh.

### 2.4 Logout / Session Clear

1. On logout, clear both stored tokens from device storage.
2. Optionally clear cached profile data.

---

## 3. Direct Cloudinary Media Uploads

### 3.1 Why Use Signed Uploads

Netlify serverless functions have payload limits and are not ideal for direct large media uploads.
The mobile app should upload media directly to Cloudinary using a signed payload issued by the backend.

### 3.2 Signature Request Endpoint

The mobile app requests a Cloudinary signature from:
- `GET /api/cloudinary-sign?folder={folder}&resourceType={resourceType}`

This endpoint requires an active authenticated session and enforces `requireAuth(event)`.

### 3.3 Default Upload Folder Behavior

If the client does not provide a folder, the backend defaults to:
- `yaard/users/{userId}/{resourceType}`

This means:
- video uploads go to `yaard/users/{userId}/video`
- image uploads go to `yaard/users/{userId}/image`

### 3.4 Signature Payload

The endpoint returns a payload containing:
- `signature`
- `timestamp`
- `cloudName`
- `apiKey`
- `folder`
- `resourceType`
- `params` (the signed request parameters)

Use this payload in the Cloudinary client SDK to upload directly from the mobile app.

### 3.5 Client Upload Flow

1. Authenticate user and store access token.
2. Request upload signature with `GET /api/cloudinary-sign`.
3. Use the returned Cloudinary signature payload in the client upload request.
4. Upload directly to Cloudinary using `resource_type=video` or `resource_type=image`.
5. After upload finishes, optionally notify the backend with the public ID and asset URL.

### 3.6 Important Security Points

- The backend only issues signatures to authenticated users.
- The token is validated before any signature is generated.
- The upload folder is scoped to the authenticated user.
- The signature is cryptographically generated using the server-side Cloudinary secret.

---

## 4. Create Ad Process

### 4.1 Overview

Ad creation is a backend-driven workflow that also initializes a Paystack payment transaction.
The process is handled through `POST /api/ads`.

### 4.2 Required Input

The mobile app should send:
- `title` (required)
- `budget` (required)
- `email` (required)

Optional but recommended:
- `description`
- `videoId`
- `targetUrl`
- `currency` (default: `KES`)
- `targetCategories` (array)
- `targetLocations` (array)
- `targetAgeMin` / `targetAgeMax`
- `startsAt`
- `endsAt`
- `callbackUrl`

### 4.3 Ad Creation Sequence

1. App sends authenticated request to `POST /api/ads`.
2. Backend verifies the user session via `requireAuth(event)`.
3. Backend validates required fields and budget minimum.
4. The ad record is inserted into the `ads` table with:
   - `status = pending`
   - a generated `paystack_reference`
5. A related payment record is created in the `payments` table.
6. The backend initializes a Paystack transaction using `initializeTransaction(...)`.
7. The response includes:
   - saved `ad` data
   - `payment` payload with `authorizationUrl` and `accessCode`

### 4.4 Paystack Checkout

The mobile app should redirect the user or open the Paystack checkout flow using the returned `authorizationUrl`.
After payment completes, the app should verify the payment status through server-side verification or webhook handling.

### 4.5 Post-Ad Creation State

- The ad record is created and associated with the authenticated user.
- The ad initially enters `pending` status until payment is confirmed.
- The app can later fetch:
  - `GET /api/ads` for the user's campaigns
  - `GET /api/ads/{adId}` for details

### 4.6 Campaign Management

The mobile app can also:
- pause or resume the campaign via `PUT /api/ads/{adId}` with `status: paused` or `status: active`
- track operation metrics through `/api/ads/{adId}/impression` and `/api/ads/{adId}/click`

---

## 5. Recommended Mobile Integration Best Practices

- Store `accessToken` and `refreshToken` in secure device storage.
- Use `accessToken` for every protected API call.
- Refresh tokens only on `401` from an expired access token or before expiry.
- Do not store user passwords after login.
- Preflight all native upload requests with `GET /api/cloudinary-sign`.
- Keep upload folder paths aligned with `yaard/users/{userId}/{resourceType}`.
- Handle network failures during ad creation by retrying only idempotent operations and preserving the Paystack reference.

---

## 6. Example Mobile Workflow

1. Register or login.
2. Save tokens and fetch the current user profile.
3. Request Cloudinary upload signature.
4. Upload media directly to Cloudinary.
5. Post uploaded asset metadata or video listing to the backend.
6. Create an ad with `POST /api/ads`.
7. Complete Paystack checkout using the returned `authorizationUrl`.
8. Use `refreshToken` to keep sessions alive.

---

## 7. Endpoint Summary

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/verify-email?token={token}`
- `POST /api/auth/resend-verification`
- `POST /api/auth/refresh`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `GET /api/cloudinary-sign?folder={folder}&resourceType={resourceType}`
- `POST /api/ads`
- `GET /api/ads`
- `GET /api/ads/{adId}`
- `PUT /api/ads/{adId}`
- `POST /api/ads/{adId}/impression`
- `POST /api/ads/{adId}/click`

---

## 8. Notes

- `requireAuth(event)` is the central guard for all protected backend routes.
- Cloudinary signatures must be requested from the server, not generated in the mobile app.
- The ad creation flow is tightly coupled with Paystack and depends on a valid authenticated user session.
