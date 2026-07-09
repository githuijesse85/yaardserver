-- Migration 011: Sync `videos` table columns with application expectations
-- Idempotent: uses ADD COLUMN IF NOT EXISTS so it can be applied safely multiple times
-- Run this against your production database (psql or Supabase SQL editor)

BEGIN;

ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS video_public_id TEXT,
  ADD COLUMN IF NOT EXISTS thumbnail_url TEXT,
  ADD COLUMN IF NOT EXISTS duration INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS price DECIMAL(15,2),
  ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'KES',
  ADD COLUMN IF NOT EXISTS price_mode VARCHAR(20) NOT NULL DEFAULT 'actual'
    CHECK (price_mode IN ('actual','from','reserved','on_request')),
  ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES categories(id),
  ADD COLUMN IF NOT EXISTS contact_phone TEXT,
  ADD COLUMN IF NOT EXISTS contact_whatsapp TEXT,
  ADD COLUMN IF NOT EXISTS contact_email TEXT,
  ADD COLUMN IF NOT EXISTS location_address TEXT,
  ADD COLUMN IF NOT EXISTS location_city TEXT,
  ADD COLUMN IF NOT EXISTS location_state TEXT,
  ADD COLUMN IF NOT EXISTS location_country TEXT DEFAULT 'Kenya',
  ADD COLUMN IF NOT EXISTS location_lat DECIMAL(10,8),
  ADD COLUMN IF NOT EXISTS location_lng DECIMAL(11,8),
  ADD COLUMN IF NOT EXISTS condition TEXT CHECK (condition IN ('New','Like New','Good','Fair','For Parts')),
  ADD COLUMN IF NOT EXISTS brand TEXT,
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS year INTEGER,
  ADD COLUMN IF NOT EXISTS color TEXT,
  ADD COLUMN IF NOT EXISTS size TEXT,
  ADD COLUMN IF NOT EXISTS mileage TEXT,
  ADD COLUMN IF NOT EXISTS bedrooms INTEGER,
  ADD COLUMN IF NOT EXISTS bathrooms INTEGER,
  ADD COLUMN IF NOT EXISTS area TEXT,
  ADD COLUMN IF NOT EXISTS tags TEXT[],
  ADD COLUMN IF NOT EXISTS target_locations TEXT[],
  ADD COLUMN IF NOT EXISTS target_countries TEXT[],
  ADD COLUMN IF NOT EXISTS target_preferences TEXT[],
  ADD COLUMN IF NOT EXISTS target_age_min INTEGER,
  ADD COLUMN IF NOT EXISTS target_age_max INTEGER,
  ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS text_overlays JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS stickers JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS music_track JSONB,
  ADD COLUMN IF NOT EXISTS is_ad BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ad_id UUID,
  ADD COLUMN IF NOT EXISTS views_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS likes_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comments_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shares_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS saves_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active','draft','archived','deleted'));

-- Indexes useful for the application
CREATE INDEX IF NOT EXISTS idx_videos_price_mode ON videos (price_mode);
CREATE INDEX IF NOT EXISTS idx_videos_city ON videos (location_city);
CREATE INDEX IF NOT EXISTS idx_videos_country ON videos (location_country);
CREATE INDEX IF NOT EXISTS idx_videos_location_lat_lng ON videos (location_lat, location_lng) WHERE location_lat IS NOT NULL AND location_lng IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_videos_tags_gin ON videos USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_videos_title_trgm ON videos USING gin (title gin_trgm_ops);

-- Backfill: if price_mode exists but price is null, set on_request
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='videos' AND column_name='price_mode') THEN
    UPDATE videos SET price_mode = 'on_request' WHERE price_mode = 'actual' AND price IS NULL;
  END IF;
END$$;

COMMIT;
