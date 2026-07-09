-- Migration 002: Add contact info, location pin, and engagement fields to videos
-- Run this in Supabase SQL Editor after migration 001

-- Contact information for sellers
ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS contact_phone TEXT,
  ADD COLUMN IF NOT EXISTS contact_whatsapp TEXT,
  ADD COLUMN IF NOT EXISTS contact_email TEXT;

-- Location with geo coordinates
ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS location_address TEXT,
  ADD COLUMN IF NOT EXISTS location_city TEXT,
  ADD COLUMN IF NOT EXISTS location_state TEXT,
  ADD COLUMN IF NOT EXISTS location_country TEXT DEFAULT 'Kenya',
  ADD COLUMN IF NOT EXISTS location_lat DECIMAL(10, 8),
  ADD COLUMN IF NOT EXISTS location_lng DECIMAL(11, 8);

-- Product detail attributes
ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS condition TEXT CHECK (condition IN ('New', 'Like New', 'Good', 'Fair', 'For Parts')),
  ADD COLUMN IF NOT EXISTS brand TEXT,
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS year INTEGER,
  ADD COLUMN IF NOT EXISTS color TEXT,
  ADD COLUMN IF NOT EXISTS size TEXT,
  ADD COLUMN IF NOT EXISTS mileage TEXT,
  ADD COLUMN IF NOT EXISTS bedrooms INTEGER,
  ADD COLUMN IF NOT EXISTS bathrooms INTEGER,
  ADD COLUMN IF NOT EXISTS area TEXT;

-- Engagement counters
ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS calls_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS whatsapp_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS email_count INTEGER NOT NULL DEFAULT 0;

-- Update shares_count if not exists
ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS shares_count INTEGER NOT NULL DEFAULT 0;

-- WhatsApp field in user profiles
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS whatsapp TEXT,
  ADD COLUMN IF NOT EXISTS website TEXT,
  ADD COLUMN IF NOT EXISTS total_views INTEGER NOT NULL DEFAULT 0;

-- Contact tracking table
CREATE TABLE IF NOT EXISTS contact_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  contact_type TEXT NOT NULL CHECK (contact_type IN ('call', 'whatsapp', 'email', 'view_map')),
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Geo index for nearby search
CREATE INDEX IF NOT EXISTS idx_videos_location ON videos (location_lat, location_lng)
  WHERE location_lat IS NOT NULL AND location_lng IS NOT NULL;

-- City index for filtering
CREATE INDEX IF NOT EXISTS idx_videos_city ON videos (location_city);
CREATE INDEX IF NOT EXISTS idx_videos_country ON videos (location_country);
CREATE INDEX IF NOT EXISTS idx_videos_brand ON videos (brand);
CREATE INDEX IF NOT EXISTS idx_videos_year ON videos (year);
CREATE INDEX IF NOT EXISTS idx_contact_events_video ON contact_events (video_id, contact_type);

-- Function: track a contact event and increment counter
CREATE OR REPLACE FUNCTION track_contact_event(
  p_video_id UUID,
  p_user_id UUID,
  p_type TEXT
) RETURNS VOID AS $$
BEGIN
  INSERT INTO contact_events (video_id, user_id, contact_type)
  VALUES (p_video_id, p_user_id, p_type);

  IF p_type = 'call' THEN
    UPDATE videos SET calls_count = calls_count + 1 WHERE id = p_video_id;
  ELSIF p_type = 'whatsapp' THEN
    UPDATE videos SET whatsapp_count = whatsapp_count + 1 WHERE id = p_video_id;
  ELSIF p_type = 'email' THEN
    UPDATE videos SET email_count = email_count + 1 WHERE id = p_video_id;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- View: videos with all joined data (updated)
CREATE OR REPLACE VIEW video_feed AS
SELECT
  v.*,
  u.username,
  u.display_name,
  u.avatar_url,
  u.is_verified,
  c.name AS category_name,
  c.slug AS category_slug
FROM videos v
JOIN users u ON u.id = v.user_id
LEFT JOIN categories c ON c.id = v.category_id
WHERE v.status = 'active';

-- Reports table if not exists
CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id UUID REFERENCES videos(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status);
CREATE INDEX IF NOT EXISTS idx_reports_video ON reports (video_id);
