-- =====================================================
-- Migration 008: price_mode column + new categories
-- Run this in Supabase SQL Editor after migrations 001-007
-- =====================================================

-- Add price_mode to videos table
-- Values: 'actual' (default), 'from', 'reserved', 'on_request'
ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS price_mode VARCHAR(20) NOT NULL DEFAULT 'actual'
    CHECK (price_mode IN ('actual', 'from', 'reserved', 'on_request'));

-- Index for filtering by price mode
CREATE INDEX IF NOT EXISTS idx_videos_price_mode ON videos (price_mode);

-- Add missing categories (Fashion, Services, Food & Drinks already in 001 but
-- slug may differ — use ON CONFLICT to be safe)
INSERT INTO categories (name, slug, sort_order) VALUES
  ('Fashion',      'fashion',     5),
  ('Services',     'services',    7),
  ('Food & Drinks','food-drinks', 6),
  ('Other',        'other',       8)
ON CONFLICT (slug) DO UPDATE SET
  name       = EXCLUDED.name,
  sort_order = EXCLUDED.sort_order;

-- Backfill existing rows: if price IS NULL, set price_mode to 'on_request'
UPDATE videos SET price_mode = 'on_request' WHERE price IS NULL AND price_mode = 'actual';
