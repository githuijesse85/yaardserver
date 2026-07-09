-- Supabase-compatible video and category schema
-- Safe to run repeatedly; uses IF NOT EXISTS and ADD COLUMN IF NOT EXISTS.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.categories (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  name character varying(100) NOT NULL,
  slug character varying(100) NOT NULL,
  icon_url text NULL,
  parent_id uuid NULL,
  sort_order integer NULL DEFAULT 0,
  created_at timestamp with time zone NULL DEFAULT now(),
  CONSTRAINT categories_pkey PRIMARY KEY (id),
  CONSTRAINT categories_slug_key UNIQUE (slug),
  CONSTRAINT categories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.categories(id)
);

ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS name character varying(100),
  ADD COLUMN IF NOT EXISTS slug character varying(100),
  ADD COLUMN IF NOT EXISTS icon_url text,
  ADD COLUMN IF NOT EXISTS parent_id uuid,
  ADD COLUMN IF NOT EXISTS sort_order integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now();

CREATE TABLE IF NOT EXISTS public.videos (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  user_id uuid NOT NULL,
  category_id uuid NULL,
  title character varying(300) NOT NULL,
  description text NULL,
  video_url text NOT NULL,
  video_public_id text NULL,
  thumbnail_url text NULL,
  duration integer NULL DEFAULT 0,
  price numeric(15, 2) NULL,
  currency character varying(10) NULL DEFAULT 'KES'::character varying,
  location character varying(255) NULL,
  latitude numeric(10, 8) NULL,
  longitude numeric(11, 8) NULL,
  tags text[] NULL,
  music_track jsonb NULL,
  text_overlays jsonb NULL DEFAULT '[]'::jsonb,
  stickers jsonb NULL DEFAULT '[]'::jsonb,
  status character varying(20) NULL DEFAULT 'active'::character varying,
  is_ad boolean NULL DEFAULT false,
  ad_id uuid NULL,
  views_count integer NULL DEFAULT 0,
  likes_count integer NULL DEFAULT 0,
  comments_count integer NULL DEFAULT 0,
  shares_count integer NULL DEFAULT 0,
  saves_count integer NULL DEFAULT 0,
  created_at timestamp with time zone NULL DEFAULT now(),
  updated_at timestamp with time zone NULL DEFAULT now(),
  contact_phone text NULL,
  contact_whatsapp text NULL,
  contact_email text NULL,
  location_address text NULL,
  location_city text NULL,
  location_state text NULL,
  location_country text NULL DEFAULT 'Nigeria'::text,
  location_lat numeric(10, 8) NULL,
  location_lng numeric(11, 8) NULL,
  condition text NULL,
  brand text NULL,
  model text NULL,
  year integer NULL,
  color text NULL,
  size text NULL,
  mileage text NULL,
  bedrooms integer NULL,
  bathrooms integer NULL,
  area text NULL,
  calls_count integer NOT NULL DEFAULT 0,
  whatsapp_count integer NOT NULL DEFAULT 0,
  email_count integer NOT NULL DEFAULT 0,
  price_mode character varying(20) NOT NULL DEFAULT 'actual'::character varying,
  target_locations text[] NULL,
  target_countries text[] NULL,
  target_preferences text[] NULL,
  target_age_min integer NULL,
  target_age_max integer NULL,
  starts_at timestamp with time zone NULL,
  ends_at timestamp with time zone NULL,
  CONSTRAINT videos_pkey PRIMARY KEY (id),
  CONSTRAINT videos_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id),
  CONSTRAINT videos_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE,
  CONSTRAINT videos_condition_check CHECK ((condition IS NULL) OR (condition = ANY (ARRAY['New'::text, 'Like New'::text, 'Good'::text, 'Fair'::text, 'For Parts'::text]))),
  CONSTRAINT videos_price_mode_check CHECK ((price_mode)::text = ANY ((ARRAY['actual'::character varying, 'from'::character varying, 'reserved'::character varying, 'on_request'::character varying])::text[])),
  CONSTRAINT videos_status_check CHECK ((status)::text = ANY ((ARRAY['active'::character varying, 'draft'::character varying, 'archived'::character varying, 'deleted'::character varying])::text[]))
);

ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS category_id uuid,
  ADD COLUMN IF NOT EXISTS title character varying(300),
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS video_url text,
  ADD COLUMN IF NOT EXISTS video_public_id text,
  ADD COLUMN IF NOT EXISTS thumbnail_url text,
  ADD COLUMN IF NOT EXISTS duration integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS price numeric(15, 2),
  ADD COLUMN IF NOT EXISTS currency character varying(10) DEFAULT 'KES'::character varying,
  ADD COLUMN IF NOT EXISTS location character varying(255),
  ADD COLUMN IF NOT EXISTS latitude numeric(10, 8),
  ADD COLUMN IF NOT EXISTS longitude numeric(11, 8),
  ADD COLUMN IF NOT EXISTS tags text[],
  ADD COLUMN IF NOT EXISTS music_track jsonb,
  ADD COLUMN IF NOT EXISTS text_overlays jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS stickers jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS status character varying(20) DEFAULT 'active'::character varying,
  ADD COLUMN IF NOT EXISTS is_ad boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS ad_id uuid,
  ADD COLUMN IF NOT EXISTS views_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS likes_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comments_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shares_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS saves_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now(),
  ADD COLUMN IF NOT EXISTS contact_phone text,
  ADD COLUMN IF NOT EXISTS contact_whatsapp text,
  ADD COLUMN IF NOT EXISTS contact_email text,
  ADD COLUMN IF NOT EXISTS location_address text,
  ADD COLUMN IF NOT EXISTS location_city text,
  ADD COLUMN IF NOT EXISTS location_state text,
  ADD COLUMN IF NOT EXISTS location_country text DEFAULT 'Nigeria'::text,
  ADD COLUMN IF NOT EXISTS location_lat numeric(10, 8),
  ADD COLUMN IF NOT EXISTS location_lng numeric(11, 8),
  ADD COLUMN IF NOT EXISTS condition text,
  ADD COLUMN IF NOT EXISTS brand text,
  ADD COLUMN IF NOT EXISTS model text,
  ADD COLUMN IF NOT EXISTS year integer,
  ADD COLUMN IF NOT EXISTS color text,
  ADD COLUMN IF NOT EXISTS size text,
  ADD COLUMN IF NOT EXISTS mileage text,
  ADD COLUMN IF NOT EXISTS bedrooms integer,
  ADD COLUMN IF NOT EXISTS bathrooms integer,
  ADD COLUMN IF NOT EXISTS area text,
  ADD COLUMN IF NOT EXISTS calls_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS whatsapp_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS email_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS price_mode character varying(20) DEFAULT 'actual'::character varying,
  ADD COLUMN IF NOT EXISTS target_locations text[],
  ADD COLUMN IF NOT EXISTS target_countries text[],
  ADD COLUMN IF NOT EXISTS target_preferences text[],
  ADD COLUMN IF NOT EXISTS target_age_min integer,
  ADD COLUMN IF NOT EXISTS target_age_max integer,
  ADD COLUMN IF NOT EXISTS starts_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS ends_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS idx_videos_user_id ON public.videos USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_videos_category_id ON public.videos USING btree (category_id);
CREATE INDEX IF NOT EXISTS idx_videos_status ON public.videos USING btree (status);
CREATE INDEX IF NOT EXISTS idx_videos_is_ad ON public.videos USING btree (is_ad);
CREATE INDEX IF NOT EXISTS idx_videos_created_at ON public.videos USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_title_trgm ON public.videos USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_videos_location ON public.videos USING btree (location_lat, location_lng) WHERE (location_lat IS NOT NULL AND location_lng IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_videos_city ON public.videos USING btree (location_city);
CREATE INDEX IF NOT EXISTS idx_videos_country ON public.videos USING btree (location_country);
CREATE INDEX IF NOT EXISTS idx_videos_brand ON public.videos USING btree (brand);
CREATE INDEX IF NOT EXISTS idx_videos_year ON public.videos USING btree (year);
CREATE INDEX IF NOT EXISTS idx_videos_price_mode ON public.videos USING btree (price_mode);
CREATE INDEX IF NOT EXISTS idx_videos_tags_gin ON public.videos USING gin (tags);

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS videos_updated_at ON public.videos;
CREATE TRIGGER videos_updated_at
BEFORE UPDATE ON public.videos
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at();
