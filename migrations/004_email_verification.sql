-- =====================================================
-- Migration 004: Email Verification
-- Run this SQL in your Supabase SQL Editor
-- =====================================================

-- Add email verification columns to users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verification_token VARCHAR(255),
  ADD COLUMN IF NOT EXISTS email_verification_expires TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- Index for fast token lookup
CREATE INDEX IF NOT EXISTS idx_users_email_verification_token
  ON users(email_verification_token)
  WHERE email_verification_token IS NOT NULL;

-- Add password reset columns while we're here (used by forgot-password)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_reset_token VARCHAR(255),
  ADD COLUMN IF NOT EXISTS password_reset_expires TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_password_reset_token
  ON users(password_reset_token)
  WHERE password_reset_token IS NOT NULL;
