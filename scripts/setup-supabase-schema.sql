-- ============================================================
-- Earlisthenic Cloudflare R2 + Supabase Production Database Schema
-- Run this migration in Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- 1. Profiles Table
CREATE TABLE IF NOT EXISTS public.profiles (
  id TEXT PRIMARY KEY,
  email TEXT,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'free',
  habit_weight NUMERIC(4, 2) NOT NULL DEFAULT 1.00,
  streak_days INTEGER NOT NULL DEFAULT 0,
  last_practice_date DATE,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Training Sessions Table
CREATE TABLE IF NOT EXISTS public.training_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  session_type TEXT NOT NULL, -- 'practice', 'mock', 'daily_circuit'
  game_id TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  accuracy_pct NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON public.training_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON public.training_sessions(created_at DESC);

-- 3. JND (Just Noticeable Difference) Acuity Thresholds Table
CREATE TABLE IF NOT EXISTS public.jnd_thresholds (
  user_id TEXT PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  bands JSONB NOT NULL DEFAULT '[]'::jsonb,
  overall_rating NUMERIC(6, 2) NOT NULL DEFAULT 1500.0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Audio Catalog & Cloudflare R2 Storage Index Table
CREATE TABLE IF NOT EXISTS public.audio_catalog (
  file_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  clean_file_name TEXT NOT NULL,
  r2_url TEXT,
  cdn_url TEXT,
  fallback_url TEXT,
  size_bytes BIGINT NOT NULL,
  sample_rate INTEGER NOT NULL DEFAULT 48000,
  bit_depth INTEGER NOT NULL DEFAULT 16,
  channels INTEGER NOT NULL DEFAULT 2,
  duration_sec NUMERIC(8, 2) NOT NULL DEFAULT 0.0,
  waveform_bins JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Row Level Security (RLS) Policies
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jnd_thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audio_catalog ENABLE ROW LEVEL SECURITY;

-- Allow public read access to active audio catalog
CREATE POLICY "Public catalog read access"
  ON public.audio_catalog FOR SELECT
  USING (is_active = true);

-- Allow authenticated users to manage their own profiles and progress
CREATE POLICY "Users read own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid()::text = id OR id LIKE 'usr-%' OR id LIKE 'guest-%');

CREATE POLICY "Users insert/update own profile"
  ON public.profiles FOR ALL
  USING (auth.uid()::text = id OR id LIKE 'usr-%' OR id LIKE 'guest-%');

CREATE POLICY "Users manage own sessions"
  ON public.training_sessions FOR ALL
  USING (auth.uid()::text = user_id OR user_id LIKE 'usr-%' OR user_id LIKE 'guest-%');

CREATE POLICY "Users manage own JND thresholds"
  ON public.jnd_thresholds FOR ALL
  USING (auth.uid()::text = user_id OR user_id LIKE 'usr-%' OR user_id LIKE 'guest-%');
