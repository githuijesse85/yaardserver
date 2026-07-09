-- Migration 006: Add missing user profile fields
-- Run this in Supabase SQL Editor after migration 005

-- Add missing profile fields to users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS whatsapp VARCHAR(20),
  ADD COLUMN IF NOT EXISTS website VARCHAR(255),
  ADD COLUMN IF NOT EXISTS total_views BIGINT DEFAULT 0;

-- Create index for better performance on profile lookups
CREATE INDEX IF NOT EXISTS idx_users_whatsapp ON users(whatsapp);

-- Add notifications table for mobile app push notifications
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL CHECK (type IN ('upload_started', 'upload_progress', 'upload_completed', 'upload_failed', 'comment', 'like', 'follow', 'message')),
  title VARCHAR(255) NOT NULL,
  body TEXT,
  data JSONB DEFAULT '{}',
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);

-- Add upload tracking table for progress
CREATE TABLE IF NOT EXISTS upload_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upload_type VARCHAR(20) NOT NULL CHECK (upload_type IN ('video', 'image', 'music')),
  resource_type VARCHAR(20) NOT NULL CHECK (resource_type IN ('video', 'image', 'audio', 'raw')),
  cloudinary_public_id VARCHAR(255),
  filename VARCHAR(255),
  file_size BIGINT,
  progress_percent INTEGER DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'uploading', 'processing', 'completed', 'failed')),
  error_message TEXT,
  metadata JSONB DEFAULT '{}',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_user_id ON upload_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_status ON upload_sessions(status);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_created_at ON upload_sessions(created_at DESC);

-- Add table for storing video marketing analytics
CREATE TABLE IF NOT EXISTS video_analytics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  views_count INTEGER DEFAULT 0,
  likes_count INTEGER DEFAULT 0,
  comments_count INTEGER DEFAULT 0,
  shares_count INTEGER DEFAULT 0,
  saves_count INTEGER DEFAULT 0,
  calls_count INTEGER DEFAULT 0,
  whatsapp_count INTEGER DEFAULT 0,
  email_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(video_id, date)
);

CREATE INDEX IF NOT EXISTS idx_video_analytics_video_id ON video_analytics(video_id);
CREATE INDEX IF NOT EXISTS idx_video_analytics_date ON video_analytics(date DESC);

-- Add contact_events table for tracking user interactions
CREATE TABLE IF NOT EXISTS contact_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  video_id UUID NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  contact_type VARCHAR(20) NOT NULL CHECK (contact_type IN ('call', 'whatsapp', 'email', 'view_map')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_events_video_id ON contact_events(video_id);
CREATE INDEX IF NOT EXISTS idx_contact_events_user_id ON contact_events(user_id);
CREATE INDEX IF NOT EXISTS idx_contact_events_created_at ON contact_events(created_at DESC);
