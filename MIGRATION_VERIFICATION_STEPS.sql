-- Complete Database Verification & Fix
-- Run these commands in sequence in Supabase SQL Editor

-- ===== STEP 1: Verify users table structure =====
\echo '--- STEP 1: Current users table columns ---'
SELECT column_name, data_type, is_nullable
FROM information_schema.columns 
WHERE table_name = 'users'
ORDER BY ordinal_position;

-- ===== STEP 2: Add missing location column if needed =====
\echo '--- STEP 2: Adding location column (if needed) ---'
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS location VARCHAR(255);

-- ===== STEP 3: Create index =====
\echo '--- STEP 3: Creating location index ---'
CREATE INDEX IF NOT EXISTS idx_users_location ON users(location);

-- ===== STEP 4: Test a full profile SELECT =====
\echo '--- STEP 4: Testing full profile query ---'
SELECT id, email, username, display_name, bio, avatar_url, cover_url,
       phone, whatsapp, website, location,
       is_verified, is_business, followers_count, following_count,
       videos_count, total_likes, total_views, created_at
FROM users 
LIMIT 1;

-- ===== STEP 5: Show table statistics =====
\echo '--- STEP 5: Users table info ---'
SELECT 
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size
FROM pg_tables
WHERE tablename = 'users';
