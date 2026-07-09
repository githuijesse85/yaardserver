# Mobile App Integration Guide

**Base API root:** `https://yaardserver.netlify.app/api`

For local development, use your local domain and append `/api`.

---

## General Notes

- All protected endpoints require:
  ```http
  Authorization: Bearer {accessToken}
  ```
- Successful responses are wrapped as:
  ```json
  {
    "success": true,
    "data": { ... }
  }
  ```
- Failed responses return:
  ```json
  {
    "success": false,
    "error": "message"
  }
  ```
- Use `Content-Type: application/json` for request bodies.

---

## Authentication

### Register
```http
POST /api/auth/register
Content-Type: application/json

{
  "email": "user@example.com",
  "username": "username",
  "password": "secure_password",
  "displayName": "User Name",
  "phone": "+254123456789"
}
```

Response: `201 Created`
```json
{
  "success": true,
  "data": {
    "user": { ... },
    "token": "jwt_token",
    "accessToken": "jwt_token",
    "refreshToken": "refresh_token",
    "message": "Registration successful. Please verify your account via the sent email link."
  }
}
```

### Login
```http
POST /api/auth/login
Content-Type: application/json

{
  "emailOrUsername": "user@example.com",
  "password": "secure_password"
}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "user": { ... },
    "token": "jwt_token",
    "accessToken": "jwt_token",
    "refreshToken": "refresh_token"
  }
}
```

### Verify Email
```http
GET /api/auth/verify-email?token=verification_token
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "message": "Email address verified successfully. Account unlocked."
  }
}
```

### Resend Verification
```http
POST /api/auth/resend-verification
Content-Type: application/json

{
  "email": "user@example.com"
}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "message": "If this email exists and remains unverified, an activation thread has been transmitted."
  }
}
```

### Refresh Tokens
```http
POST /api/auth/refresh
Content-Type: application/json

{
  "refreshToken": "refresh_token"
}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "user": { ... },
    "token": "new_access_token",
    "accessToken": "new_access_token",
    "refreshToken": "new_refresh_token"
  }
}
```

### Forgot Password
```http
POST /api/auth/forgot-password
Content-Type: application/json

{
  "email": "user@example.com"
}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "message": "If this record exists, a verification recovery path has been dispatched."
  }
}
```

### Reset Password
```http
POST /api/auth/reset-password
Content-Type: application/json

{
  "token": "reset_token",
  "newPassword": "NewPassword123!"
}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "message": "Password mutated successfully. Account unlocked."
  }
}
```

---

## Users

### Get Current User
```http
GET /api/users/me
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "email": "user@example.com",
    "username": "username",
    "display_name": "User Name",
    "bio": "Bio text",
    "avatar_url": "https://...",
    "cover_url": "https://...",
    "phone": "+254123456789",
    "whatsapp": "+254123456789",
    "website": "https://...",
    "is_verified": false,
    "is_business": false,
    "followers_count": 100,
    "following_count": 50,
    "videos_count": 25,
    "total_likes": 500,
    "total_views": 5000,
    "created_at": "2026-05-25T..."
  }
}
```

### Update Profile
```http
PUT /api/users/me
Authorization: Bearer {accessToken}
Content-Type: application/json

{
  "displayName": "New Name",
  "bio": "New bio",
  "avatarUrl": "https://cloudinary.com/...",
  "coverUrl": "https://cloudinary.com/...",
  "phone": "+254987654321",
  "whatsapp": "+254987654321",
  "website": "https://newsite.com"
}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": { ... }
}
```

### Search Users
```http
GET /api/users/search?q=username_query
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "username": "username",
      "display_name": "Name",
      "avatar_url": "https://...",
      "is_verified": true,
      "followers_count": 1000,
      "is_business": false
    }
  ]
}
```

### Get Public Profile
```http
GET /api/users/{username}
Authorization: Bearer {accessToken}  # optional
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "username": "username",
    "display_name": "Name",
    "bio": "...",
    "avatar_url": "https://...",
    "cover_url": "https://...",
    "is_verified": true,
    "is_business": false,
    "followers_count": 100,
    "following_count": 50,
    "videos_count": 20,
    "total_likes": 200,
    "total_views": 1500,
    "is_following": false
  }
}
```

### Follow User
```http
POST /api/users/{userId}/follow
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "following": true
  }
}
```

### Unfollow User
```http
DELETE /api/users/{userId}/follow
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "following": false
  }
}
```

### Followers
```http
GET /api/users/{userId}/followers
Authorization: Bearer {accessToken}  # optional
```

Response: `200 OK`
```json
{
  "success": true,
  "data": [ ... ]
}
```

### Following
```http
GET /api/users/{userId}/following
Authorization: Bearer {accessToken}  # optional
```

Response: `200 OK`
```json
{
  "success": true,
  "data": [ ... ]
}
```

---

## Feed

### For You Feed
```http
GET /api/feed?page=1&limit=10
Authorization: Bearer {accessToken}  # optional
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "feed": [ ... ],
    "page": 1,
    "limit": 10
  }
}
```

### Following Feed
```http
GET /api/feed/following?page=1&limit=10
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "feed": [ ... ],
    "page": 1,
    "limit": 10
  }
}
```

### Trending Feed
```http
GET /api/feed/trending?category=electronics
Authorization: Bearer {accessToken}  # optional
```

Response: `200 OK`
```json
{
  "success": true,
  "data": [ ... ]
}
```

### Saved Feed
```http
GET /api/feed/saved
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": [ ... ]
}
```

### Categories
```http
GET /api/feed/categories
Authorization: Bearer {accessToken}  # optional
```

Response: `200 OK`
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "name": "Electronics",
      "slug": "electronics",
      "video_count": 42
    }
  ]
}
```

### Music Tracks
```http
GET /api/feed/music
Authorization: Bearer {accessToken}  # optional
```

Response: `200 OK`
```json
{
  "success": true,
  "data": [ ... ]
}
```

---

## Search

### Global Search
```http
GET /api/search?q=iphone&type=all
Authorization: Bearer {accessToken}  # optional
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "query": "iphone",
    "results": {
      "videos": [ ... ],
      "users": [ ... ],
      "hashtags": [ ... ]
    }
  }
}
```

Supported `type` values: `all`, `videos`, `users`, `hashtags`.

---

## Videos

### List Videos
```http
GET /api/videos?limit=20&offset=0
Authorization: Bearer {accessToken}  # optional
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "videos": [ ... ]
  }
}
```

### Get Video
```http
GET /api/videos/{videoId}
Authorization: Bearer {accessToken}  # optional
```

Response: `200 OK`
```json
{
  "success": true,
  "data": { ... }
}
```

### Create Video Listing
```http
POST /api/videos
Authorization: Bearer {accessToken}
Content-Type: application/json

{
  "title": "iPhone 13 Pro for Sale",
  "description": "Excellent condition",
  "video_url": "https://cloudinary.com/...",
  "thumbnail_url": "https://...",
  "price": 45000,
  "currency": "KES",
  "category_id": "electronics-uuid",
  "location_city": "Nairobi",
  "condition": "Like New",
  "brand": "Apple",
  "model": "iPhone 13 Pro",
  "video_public_id": "cloudinary_public_id"
}
```

Response: `201 Created`
```json
{
  "success": true,
  "data": { ... }
}
```

### Update Video
```http
PUT /api/videos/{videoId}
Authorization: Bearer {accessToken}
Content-Type: application/json

{
  "title": "New title",
  "description": "Updated details",
  "price": 42000,
  "location_city": "Nairobi",
  "condition": "Used",
  "status": "active"
}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": { ... }
}
```

### Delete Video
```http
DELETE /api/videos/{videoId}
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "message": "Video deleted successfully"
  }
}
```

### Like Video
```http
POST /api/videos/{videoId}/like
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "liked": true,
    "likes_count": 51
  }
}
```

### Unlike Video
```http
DELETE /api/videos/{videoId}/like
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "liked": false,
    "likes_count": 50
  }
}
```

### Save Video
```http
POST /api/videos/{videoId}/save
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "saved": true,
    "saves_count": 26
  }
}
```

### Unsave Video
```http
DELETE /api/videos/{videoId}/save
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "saved": false,
    "saves_count": 25
  }
}
```

---

## Images

### Request Upload Signature
```http
POST /api/images/upload-signature
Authorization: Bearer {accessToken}
Content-Type: application/json

{
  "imageType": "avatar",
  "resourceType": "image"
}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "sessionId": "uuid",
    "signature": "...",
    "timestamp": 1234567890,
    "cloudName": "your_cloud_name",
    "apiKey": "your_api_key",
    "folder": "yaard/users/{userId}/avatar"
  }
}
```

### Complete Image Upload
```http
POST /api/images/upload-complete
Authorization: Bearer {accessToken}
Content-Type: application/json

{
  "sessionId": "uuid",
  "imageType": "avatar",
  "cloudinaryPublicId": "sample_public_id",
  "imageUrl": "https://...",
  "width": 600,
  "height": 600
}
```

Response: `201 Created`
```json
{
  "success": true,
  "data": {
    "message": "Upload completed successfully",
    "sessionId": "uuid",
    "imageType": "avatar",
    "imageUrl": "https://...",
    "publicId": "sample_public_id"
  }
}
```

### Upload Progress
```http
POST /api/images/upload-progress
Authorization: Bearer {accessToken}
Content-Type: application/json

{
  "sessionId": "uuid",
  "progressPercent": 75
}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "sessionId": "uuid",
    "progressPercent": 75,
    "status": "uploading"
  }
}
```

### Upload Session Status
```http
GET /api/images/session/{sessionId}
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "status": "processing",
    "progress_percent": 100,
    "cloudinary_public_id": "sample_public_id",
    "error_message": null,
    "metadata": { ... },
    "created_at": "2026-05-25T..."
  }
}
```

### Delete Avatar
```http
DELETE /api/images/avatar
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "message": "avatar deleted successfully"
  }
}
```

### Delete Cover
```http
DELETE /api/images/cover
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "message": "cover deleted successfully"
  }
}
```

### Cloudinary Direct Upload Signature
```http
GET /api/cloudinary-sign?folder=yaard/users/{userId}/video&resourceType=video
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "signature": "...",
    "timestamp": 1234567890,
    "cloudName": "your_cloud_name",
    "apiKey": "your_api_key",
    "folder": "yaard/users/{userId}/video",
    "resourceType": "video",
    "params": { ... }
  }
}
```

---

## Comments

### List Comments
```http
GET /api/comments/video/{videoId}?page=1&limit=20
Authorization: Bearer {accessToken}  # optional
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "comments": [ ... ],
    "page": 1,
    "limit": 20
  }
}
```

### Create Comment
```http
POST /api/comments
Authorization: Bearer {accessToken}
Content-Type: application/json

{
  "videoId": "uuid",
  "content": "Great video!",
  "parentId": "optional_comment_id"
}
```

Response: `201 Created`
```json
{
  "success": true,
  "data": { ... }
}
```

### Delete Comment
```http
DELETE /api/comments/{commentId}
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "deleted": true
  }
}
```

### Like Comment
```http
POST /api/comments/{commentId}/like
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "likes_count": 11
  }
}
```

### Unlike Comment
```http
DELETE /api/comments/{commentId}/like
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "likes_count": 10
  }
}
```

---

## Notifications

### List Notifications
```http
GET /api/notifications?page=1&limit=20&unread=true
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "notifications": [ ... ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 25,
      "unread": 7
    }
  }
}
```

### Unread Count
```http
GET /api/notifications/unread-count
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "unreadCount": 7
  }
}
```

### Mark Notification Read
```http
PUT /api/notifications/{notificationId}/read
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": { ... }
}
```

### Mark All Read
```http
PUT /api/notifications/read-all
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "message": "All notifications marked as read"
  }
}
```

### Delete Notification
```http
DELETE /api/notifications/{notificationId}
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "deleted": true
  }
}
```

### Delete All Notifications
```http
DELETE /api/notifications/delete-all
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "message": "All notifications deleted"
  }
}
```

### By Type
```http
GET /api/notifications/by-type/upload_progress?limit=20
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": [ ... ]
}
```

---

## Ads

### List Ads
```http
GET /api/ads
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": [ ... ]
}
```

### Create Ad
```http
POST /api/ads
Authorization: Bearer {accessToken}
Content-Type: application/json

{
  "videoId": "uuid",
  "title": "Promote my listing",
  "description": "This is a sponsored listing",
  "targetUrl": "https://yaard.netlify.app/video/123",
  "budget": 15000,
  "currency": "KES",
  "targetCategories": ["electronics", "fashion"],
  "targetLocations": ["Nairobi", "Mombasa"],
  "targetAgeMin": 18,
  "targetAgeMax": 45,
  "startsAt": "2026-06-01T00:00:00Z",
  "endsAt": "2026-06-15T00:00:00Z",
  "email": "seller@example.com",
  "callbackUrl": "https://app.example.com/ads/callback"
}
```

Response: `201 Created`
```json
{
  "success": true,
  "data": {
    "ad": { ... },
    "payment": {
      "reference": "YAARD_AD_...",
      "authorizationUrl": "https://checkout.paystack.com/...",
      "accessCode": "..."
    }
  }
}
```

### Get Ad
```http
GET /api/ads/{adId}
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": { ... }
}
```

### Update Ad
```http
PUT /api/ads/{adId}
Authorization: Bearer {accessToken}
Content-Type: application/json

{
  "status": "paused"
}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": { ... }
}
```

### Track Impression
```http
POST /api/ads/{adId}/impression
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "tracked": true
  }
}
```

### Track Click
```http
POST /api/ads/{adId}/click
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "tracked": true
  }
}
```

---

## Payments

### List Payments
```http
GET /api/payments
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": [ ... ]
}
```

### Verify Payment
```http
GET /api/payments/verify/{reference}
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "verified": true,
    "status": "success",
    "amount": 15000,
    "currency": "KES",
    "ad": { ... },
    "transaction": { ... }
  }
}
```

### Payment Webhook
```http
POST /api/payments/webhook
Content-Type: application/json
X-Paystack-Signature: {signature}

{
  "event": "charge.success",
  "data": { ... }
}
```

Response: `200 OK`
```json
{
  "received": true
}
```

### Payment Stats
```http
GET /api/payments/stats
Authorization: Bearer {accessToken}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "payments": { ... },
    "ads": { ... }
  }
}
```

### Refund
```http
POST /api/payments/refund/{reference}
Authorization: Bearer {accessToken}
Content-Type: application/json

{
  "amount": 15000
}
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "refund": { ... }
  }
}
```

---

## Health Check

```http
GET /api/health
```

Response: `200 OK`
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "version": "1.0.0",
    "app": "Yaard API",
    "timestamp": "2026-05-25T...",
    "database": {
      "connected": true,
      "time": "2026-05-25T..."
    }
  }
}
```

---

## Error Responses

All errors are returned as:
```json
{
  "success": false,
  "error": "Error message"
}
```

## Notes

- `accessToken` is the JWT used for authenticated requests.
- `refreshToken` is used only with `/api/auth/refresh`.
- The server returns both `token` and `accessToken` for compatibility.
- Use `/api/cloudinary-sign` to obtain a signed Cloudinary payload for direct client-side uploads.
