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
  delivery_method    text,                           -- 'post' or 'alternate'
  delivery_notes     text,                           -- hand delivery / via a friend details
  mobile             text,                           -- contact mobile (alternate delivery)
  status             text not null default 'paid',
  created_at         timestamptz not null default now()
);

-- If the orders table already exists from an earlier version, add the new
-- delivery columns (safe to run repeatedly).
alter table public.orders add column if not exists delivery_method text;
alter table public.orders add column if not exists delivery_notes text;
alter table public.orders add column if not exists mobile text;

-- Lock the table down. The webhook writes with the service_role key, which
-- bypasses Row Level Security, so it needs no policy. Enabling RLS with NO
-- policies means the public/anon key can neither read nor write — orders stay
-- private and can only be reached with the secret service_role key.
alter table public.orders enable row level security;


-- Fragrance requests — enquiries from the "Request a Fragrance" section, each
-- correlated to a specific fragrance in the wholesale library (catalogue.json).
-- Written by api/request.js and read by api/requests.js (admin), both with the
-- service_role key.
create table if not exists public.fragrance_requests (
  id              uuid primary key default gen_random_uuid(),
  requester_name  text not null,
  email           text not null,
  note            text,
  quantity        integer not null default 1,
  fragrance_name  text not null,       -- correlates the request to the library item
  brand           text,
  size            text,
  price           numeric,
  product_id      text,
  status          text not null default 'new',
  created_at      timestamptz not null default now()
);

-- Same lock-down as orders: RLS on, no policies → only the service_role key
-- (server-side) can read or write. Enquiries stay private.
alter table public.fragrance_requests enable row level security;
