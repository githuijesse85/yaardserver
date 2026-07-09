-- Migration 010: Add targeting metadata columns for videos and ads
-- This allows CreateVideo to capture ad targeting data and keeps ads schema consistent.

ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS target_locations TEXT[],
  ADD COLUMN IF NOT EXISTS target_countries TEXT[],
  ADD COLUMN IF NOT EXISTS target_preferences TEXT[],
  ADD COLUMN IF NOT EXISTS target_age_min INTEGER,
  ADD COLUMN IF NOT EXISTS target_age_max INTEGER,
  ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;

ALTER TABLE ads
  ADD COLUMN IF NOT EXISTS target_countries TEXT[],
  ADD COLUMN IF NOT EXISTS target_preferences TEXT[];
