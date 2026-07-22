-- Maison Obsidian — orders table.
--
-- Run this once in the Supabase SQL editor (Dashboard → SQL → New query).
-- The Stripe webhook (api/webhook.js) upserts a row here on every paid order,
-- keyed on stripe_session_id so repeated webhook deliveries are idempotent.

create table if not exists public.orders (
  id                 uuid primary key default gen_random_uuid(),
  stripe_session_id  text not null unique,          -- upsert conflict target
  payment_intent_id  text,
  email              text,
  name               text,
  amount_total       integer,                        -- smallest currency unit (cents)
  currency           text,
  items              text,                           -- human-readable line summary
  ship_address       text,
  ship_city          text,
  ship_region        text,
  ship_postcode      text,
  status             text not null default 'paid',
  created_at         timestamptz not null default now()
);

-- Lock the table down. The webhook writes with the service_role key, which
-- bypasses Row Level Security, so it needs no policy. Enabling RLS with NO
-- policies means the public/anon key can neither read nor write — orders stay
-- private and can only be reached with the secret service_role key.
alter table public.orders enable row level security;
