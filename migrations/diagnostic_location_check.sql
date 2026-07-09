-- Diagnostic: Check if location column exists and add if missing
-- Run this in Supabase SQL Editor to verify and fix the issue

-- 1. Check if the location column exists
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'users' AND column_name = 'location';

-- 2. If the above returns no rows, add the column
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS location VARCHAR(255);

-- 3. Verify the column now exists
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_name = 'users' AND column_name = 'location';

-- 4. Create the index if it doesn't exist
CREATE INDEX IF NOT EXISTS idx_users_location ON users(location);

-- 5. Verify a test user can be queried with location
SELECT id, username, display_name, bio, avatar_url, cover_url,
       phone, whatsapp, website, location,
       is_verified, is_business, followers_count, following_count,
       videos_count, total_likes, total_views, created_at
FROM users 
LIMIT 1;
