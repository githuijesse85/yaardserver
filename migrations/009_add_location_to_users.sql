-- Migration 009: Add location field to users table
-- This fixes the 500 errors when fetching user profiles (GET /me, GET /:username)
-- The backend was trying to select this column but it didn't exist

-- Add location column to users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS location VARCHAR(255);

-- Create index for location-based queries
CREATE INDEX IF NOT EXISTS idx_users_location ON users(location);
