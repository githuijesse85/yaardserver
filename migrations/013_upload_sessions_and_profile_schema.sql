-- Migration 013: Create upload session tracking and align user profile columns for media uploads

CREATE TABLE IF NOT EXISTS public.upload_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
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

CREATE INDEX IF NOT EXISTS idx_upload_sessions_user_id ON public.upload_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_status ON public.upload_sessions (status);
CREATE INDEX IF NOT EXISTS idx_upload_sessions_created_at ON public.upload_sessions (created_at DESC);

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS whatsapp TEXT,
  ADD COLUMN IF NOT EXISTS website TEXT,
  ADD COLUMN IF NOT EXISTS total_views INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS email_verification_token VARCHAR(255),
  ADD COLUMN IF NOT EXISTS email_verification_expires TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS password_reset_token VARCHAR(255),
  ADD COLUMN IF NOT EXISTS password_reset_expires TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS location VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_users_whatsapp ON public.users (whatsapp);
CREATE INDEX IF NOT EXISTS idx_users_location ON public.users (location);
