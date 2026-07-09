-- Migration 003: Switch default currency from NGN to KES (Kenya Shillings)
-- Run in Supabase SQL Editor after migrations 001 and 002

-- Update column defaults
ALTER TABLE videos   ALTER COLUMN currency SET DEFAULT 'KES';
ALTER TABLE ads      ALTER COLUMN currency SET DEFAULT 'KES';
ALTER TABLE payments ALTER COLUMN currency SET DEFAULT 'KES';

-- Optionally update existing NGN rows to KES
-- (Comment these out if you want to keep historical NGN records as-is)
UPDATE videos   SET currency = 'KES' WHERE currency = 'NGN';
UPDATE ads      SET currency = 'KES' WHERE currency = 'NGN';
UPDATE payments SET currency = 'KES' WHERE currency = 'NGN';
