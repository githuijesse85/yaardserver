-- ============================================================
-- YAARD — Master Schema (cumulative, idempotent)
-- Run this in Supabase SQL Editor on a fresh database,
-- OR run the numbered migrations 001–013 in order on an
-- existing database to apply only missing changes.
--
-- This file is the single source of truth for the full schema.
-- Generated: 2025-07-09
-- ============================================================

-- ── Extensions ───────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ── USERS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email                       VARCHAR(255) UNIQUE NOT NULL,
  username                    VARCHAR(50)  UNIQUE NOT NULL,
  password_hash               VARCHAR(255) NOT NULL,
  display_name                VARCHAR(100),
  bio                         TEXT,
  avatar_url                  TEXT,
  cover_url                   TEXT,
  phone                       VARCHAR(20),
  whatsapp                    TEXT,
  website                     TEXT,
  location                    VARCHAR(255),
  is_verified                 BOOLEAN      DEFAULT FALSE,
  is_business                 BOOLEAN      DEFAULT FALSE,
  paystack_customer_code      VARCHAR(100),
  followers_count             INTEGER      DEFAULT 0,
  following_count             INTEGER      DEFAULT 0,
  videos_count                INTEGER      DEFAULT 0,
  total_likes                 INTEGER      DEFAULT 0,
  total_views                 INTEGER      DEFAULT 0,
  -- Email verification
  email_verification_token    VARCHAR(255),
  email_verification_expires  TIMESTAMPTZ,
  email_verified_at           TIMESTAMPTZ,
  -- Password reset
  password_reset_token        VARCHAR(255),
  password_reset_expires      TIMESTAMPTZ,
  -- Timestamps
  created_at                  TIMESTAMPTZ  DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email          ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username       ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_username_trgm  ON users USING gin(username gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_display_name_trgm ON users USING gin(display_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_whatsapp       ON users(whatsapp);
CREATE INDEX IF NOT EXISTS idx_users_location       ON users(location);
CREATE INDEX IF NOT EXISTS idx_users_email_verification_token
  ON users(email_verification_token)
  WHERE email_verification_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_password_reset_token
  ON users(password_reset_token)
  WHERE password_reset_token IS NOT NULL;

-- ── CATEGORIES ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
  id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(100) NOT NULL,
  slug        VARCHAR(100) UNIQUE NOT NULL,
  icon        VARCHAR(50),
  icon_url    TEXT,
  parent_id   UUID         REFERENCES categories(id),
  sort_order  INTEGER      DEFAULT 0,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

INSERT INTO categories (name, slug, sort_order) VALUES
  ('Properties',   'properties',  1),
  ('Automotive',   'automotive',  2),
  ('Furniture',    'furniture',   3),
  ('Electronics',  'electronics', 4),
  ('Fashion',      'fashion',     5),
  ('Food & Drinks','food-drinks', 6),
  ('Services',     'services',    7),
  ('Other',        'other',       8)
ON CONFLICT (slug) DO UPDATE SET
  name       = EXCLUDED.name,
  sort_order = EXCLUDED.sort_order;

-- ── VIDEOS / LISTINGS ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS videos (
  id                  UUID           PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID           NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id         UUID           REFERENCES categories(id),
  title               VARCHAR(300)   NOT NULL,
  description         TEXT,
  video_url           TEXT           NOT NULL,
  video_public_id     TEXT,
  thumbnail_url       TEXT,
  duration            INTEGER        DEFAULT 0,
  -- Pricing
  price               DECIMAL(15,2),
  currency            VARCHAR(10)    DEFAULT 'KES',
  price_mode          VARCHAR(20)    NOT NULL DEFAULT 'actual'
                        CHECK (price_mode IN ('actual','from','reserved','on_request')),
  -- Contact
  contact_phone       TEXT,
  contact_whatsapp    TEXT,
  contact_email       TEXT,
  -- Location
  location            VARCHAR(255),
  location_address    TEXT,
  location_city       TEXT,
  location_state      TEXT,
  location_country    TEXT           DEFAULT 'Kenya',
  location_lat        DECIMAL(10,8),
  location_lng        DECIMAL(11,8),
  latitude            DECIMAL(10,8),
  longitude           DECIMAL(11,8),
  -- Item metadata
  condition           TEXT           CHECK (condition IN ('New','Like New','Good','Fair','For Parts')),
  brand               TEXT,
  model               TEXT,
  year                INTEGER,
  color               TEXT,
  size                TEXT,
  mileage             TEXT,
  bedrooms            INTEGER,
  bathrooms           INTEGER,
  area                TEXT,
  -- Rich media
  tags                TEXT[],
  music_track         JSONB,
  text_overlays       JSONB          DEFAULT '[]',
  stickers            JSONB          DEFAULT '[]',
  -- Ad targeting
  target_locations    TEXT[],
  target_countries    TEXT[],
  target_preferences  TEXT[],
  target_age_min      INTEGER,
  target_age_max      INTEGER,
  starts_at           TIMESTAMPTZ,
  ends_at             TIMESTAMPTZ,
  -- Status & ad flags
  status              VARCHAR(20)    DEFAULT 'active'
                        CHECK (status IN ('active','draft','archived','deleted')),
  is_ad               BOOLEAN        DEFAULT FALSE,
  ad_id               UUID,
  -- Counters
  views_count         INTEGER        DEFAULT 0,
  likes_count         INTEGER        DEFAULT 0,
  comments_count      INTEGER        DEFAULT 0,
  shares_count        INTEGER        DEFAULT 0,
  saves_count         INTEGER        DEFAULT 0,
  calls_count         INTEGER        DEFAULT 0,
  whatsapp_count      INTEGER        DEFAULT 0,
  email_count         INTEGER        DEFAULT 0,
  -- Timestamps
  created_at          TIMESTAMPTZ    DEFAULT NOW(),
  updated_at          TIMESTAMPTZ    DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_videos_user_id      ON videos(user_id);
CREATE INDEX IF NOT EXISTS idx_videos_category_id  ON videos(category_id);
CREATE INDEX IF NOT EXISTS idx_videos_status       ON videos(status);
CREATE INDEX IF NOT EXISTS idx_videos_is_ad        ON videos(is_ad);
CREATE INDEX IF NOT EXISTS idx_videos_created_at   ON videos(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_title_trgm   ON videos USING gin(title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_videos_price_mode   ON videos(price_mode);
CREATE INDEX IF NOT EXISTS idx_videos_tags_gin     ON videos USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_videos_city         ON videos(location_city);
CREATE INDEX IF NOT EXISTS idx_videos_country      ON videos(location_country);
CREATE INDEX IF NOT EXISTS idx_videos_brand        ON videos(brand);
CREATE INDEX IF NOT EXISTS idx_videos_year         ON videos(year);
CREATE INDEX IF NOT EXISTS idx_videos_location     ON videos(location_lat, location_lng)
  WHERE location_lat IS NOT NULL AND location_lng IS NOT NULL;

-- ── ADS / PROMOTED CONTENT ───────────────────────────────────
CREATE TABLE IF NOT EXISTS ads (
  id                   UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id             UUID          REFERENCES videos(id) ON DELETE SET NULL,
  title                VARCHAR(300)  NOT NULL,
  description          TEXT,
  target_url           TEXT,
  budget               DECIMAL(15,2) NOT NULL,
  spent                DECIMAL(15,2) DEFAULT 0,
  currency             VARCHAR(10)   DEFAULT 'KES',
  cpm                  DECIMAL(10,2) DEFAULT 500.00,
  -- Targeting
  target_categories    TEXT[],
  target_locations     TEXT[],
  target_countries     TEXT[],
  target_preferences   TEXT[],
  target_age_min       INTEGER       DEFAULT 18,
  target_age_max       INTEGER       DEFAULT 65,
  -- Status
  status               VARCHAR(20)   DEFAULT 'pending'
                         CHECK (status IN ('pending','active','paused','completed','cancelled')),
  payment_status       VARCHAR(20)   DEFAULT 'pending'
                         CHECK (payment_status IN ('pending','paid','failed','refunded')),
  paystack_reference   VARCHAR(100),
  -- Metrics
  impressions          INTEGER       DEFAULT 0,
  clicks               INTEGER       DEFAULT 0,
  -- Schedule
  starts_at            TIMESTAMPTZ,
  ends_at              TIMESTAMPTZ,
  -- Timestamps
  created_at           TIMESTAMPTZ   DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ads_user_id    ON ads(user_id);
CREATE INDEX IF NOT EXISTS idx_ads_video_id   ON ads(video_id);
CREATE INDEX IF NOT EXISTS idx_ads_status     ON ads(status);
CREATE INDEX IF NOT EXISTS idx_ads_payment_status ON ads(payment_status);

-- ── PAYMENTS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id                   UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ad_id                UUID          REFERENCES ads(id) ON DELETE SET NULL,
  amount               DECIMAL(15,2) NOT NULL,
  currency             VARCHAR(10)   DEFAULT 'KES',
  paystack_reference   VARCHAR(100)  NOT NULL,
  payment_type         VARCHAR(50)   DEFAULT 'ad',
  status               VARCHAR(20)   DEFAULT 'pending'
                         CHECK (status IN ('pending','success','failed','refunded')),
  metadata             JSONB,
  paid_at              TIMESTAMPTZ,
  created_at           TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_user_id   ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_reference ON payments(paystack_reference);
CREATE INDEX IF NOT EXISTS idx_payments_status    ON payments(status);

-- ── FOLLOWS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS follows (
  follower_id   UUID  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id  UUID  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id),
  CONSTRAINT no_self_follow CHECK (follower_id != following_id)
);

CREATE INDEX IF NOT EXISTS idx_follows_follower_id  ON follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following_id ON follows(following_id);

-- ── LIKES ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS likes (
  id          UUID  PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id    UUID  NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, video_id)
);

CREATE INDEX IF NOT EXISTS idx_likes_video_id   ON likes(video_id);
CREATE INDEX IF NOT EXISTS idx_likes_user_id    ON likes(user_id);
CREATE INDEX IF NOT EXISTS idx_likes_created_at ON likes(created_at DESC);

-- ── SAVES ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saves (
  id          UUID  PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id    UUID  NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, video_id)
);

CREATE INDEX IF NOT EXISTS idx_saves_video_id   ON saves(video_id);
CREATE INDEX IF NOT EXISTS idx_saves_user_id    ON saves(user_id);
CREATE INDEX IF NOT EXISTS idx_saves_created_at ON saves(created_at DESC);

-- ── COMMENTS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comments (
  id            UUID  PRIMARY KEY DEFAULT uuid_generate_v4(),
  video_id      UUID  NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id       UUID  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id     UUID  REFERENCES comments(id) ON DELETE CASCADE,
  content       TEXT  NOT NULL,
  likes_count   INTEGER DEFAULT 0,
  replies_count INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comments_video_id   ON comments(video_id);
CREATE INDEX IF NOT EXISTS idx_comments_user_id    ON comments(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent_id  ON comments(parent_id);
CREATE INDEX IF NOT EXISTS idx_comments_created_at ON comments(created_at DESC);

-- ── COMMENT LIKES ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS comment_likes (
  id          UUID  PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comment_id  UUID  NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_comment_likes_comment_id ON comment_likes(comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_likes_user_id    ON comment_likes(user_id);

-- ── NOTIFICATIONS ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id            UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_user_id  UUID          REFERENCES users(id) ON DELETE SET NULL,
  type          VARCHAR(50)   NOT NULL,
  title         VARCHAR(255),
  body          TEXT,
  data          JSONB,
  is_read       BOOLEAN       DEFAULT FALSE,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id     ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read   ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at  ON notifications(created_at DESC);

-- ── REPORTS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reports (
  id           UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  reporter_id  UUID         NOT NULL REFERENCES users(id),
  video_id     UUID         REFERENCES videos(id) ON DELETE SET NULL,
  user_id      UUID         REFERENCES users(id) ON DELETE SET NULL,
  reason       VARCHAR(100) NOT NULL,
  description  TEXT,
  status       VARCHAR(20)  DEFAULT 'pending',
  created_at   TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_video_id    ON reports(video_id);
CREATE INDEX IF NOT EXISTS idx_reports_reporter_id ON reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_reports_status      ON reports(status);

-- ── VIDEO VIEWS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS video_views (
  id          UUID   PRIMARY KEY DEFAULT uuid_generate_v4(),
  video_id    UUID   NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id     UUID   REFERENCES users(id) ON DELETE SET NULL,
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_views_video_id   ON video_views(video_id);
CREATE INDEX IF NOT EXISTS idx_video_views_user_id    ON video_views(user_id);
CREATE INDEX IF NOT EXISTS idx_video_views_created_at ON video_views(created_at DESC);

-- ── MUSIC TRACKS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS music_tracks (
  id          UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  title       VARCHAR(255)  NOT NULL,
  artist      VARCHAR(255),
  audio_url   TEXT          NOT NULL,
  cover_url   TEXT,
  duration    INTEGER       DEFAULT 30,
  genre       VARCHAR(100),
  is_trending BOOLEAN       DEFAULT FALSE,
  use_count   INTEGER       DEFAULT 0,
  created_at  TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_music_tracks_trending ON music_tracks(is_trending, use_count DESC);

INSERT INTO music_tracks (title, artist, audio_url, duration, genre, is_trending) VALUES
  ('Chill Vibes',  'Yaard Music', 'https://example.com/music/chill.mp3', 30, 'Ambient',  TRUE),
  ('Hype Track',   'Yaard Music', 'https://example.com/music/hype.mp3',  30, 'Hip-hop',  FALSE)
ON CONFLICT DO NOTHING;

-- ── UPLOAD SESSIONS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS upload_sessions (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upload_type           VARCHAR(20)   NOT NULL CHECK (upload_type IN ('video','image','music')),
  resource_type         VARCHAR(20)   NOT NULL CHECK (resource_type IN ('video','image','audio','raw')),
  cloudinary_public_id  VARCHAR(255),
  filename              VARCHAR(255),
  file_size             BIGINT,
  progress_percent      INTEGER       DEFAULT 0,
  status                VARCHAR(20)   NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','uploading','processing','completed','failed')),
  error_message         TEXT,
  metadata              JSONB         DEFAULT '{}',
  started_at            TIMESTAMPTZ   DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_user_id    ON upload_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_status     ON upload_sessions(status);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_created_at ON upload_sessions(created_at DESC);

-- ── VIDEO ANALYTICS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS video_analytics (
  id              UUID    PRIMARY KEY DEFAULT uuid_generate_v4(),
  video_id        UUID    NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  date            DATE    NOT NULL,
  views_count     INTEGER DEFAULT 0,
  likes_count     INTEGER DEFAULT 0,
  comments_count  INTEGER DEFAULT 0,
  shares_count    INTEGER DEFAULT 0,
  saves_count     INTEGER DEFAULT 0,
  calls_count     INTEGER DEFAULT 0,
  whatsapp_count  INTEGER DEFAULT 0,
  email_count     INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(video_id, date)
);

CREATE INDEX IF NOT EXISTS idx_video_analytics_video_id ON video_analytics(video_id);
CREATE INDEX IF NOT EXISTS idx_video_analytics_date     ON video_analytics(date DESC);

-- ── CONTACT EVENTS ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS contact_events (
  id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  video_id      UUID         NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id       UUID         REFERENCES users(id) ON DELETE SET NULL,
  contact_type  VARCHAR(20)  NOT NULL CHECK (contact_type IN ('call','whatsapp','email','view_map')),
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_events_video_id   ON contact_events(video_id);
CREATE INDEX IF NOT EXISTS idx_contact_events_user_id    ON contact_events(user_id);
CREATE INDEX IF NOT EXISTS idx_contact_events_created_at ON contact_events(created_at DESC);

-- ── TRIGGERS — auto-update updated_at ────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_updated_at    ON users;
DROP TRIGGER IF EXISTS videos_updated_at   ON videos;
DROP TRIGGER IF EXISTS ads_updated_at      ON ads;
DROP TRIGGER IF EXISTS comments_updated_at ON comments;

CREATE TRIGGER users_updated_at    BEFORE UPDATE ON users    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER videos_updated_at   BEFORE UPDATE ON videos   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER ads_updated_at      BEFORE UPDATE ON ads      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER comments_updated_at BEFORE UPDATE ON comments FOR EACH ROW EXECUTE FUNCTION update_updated_at();
