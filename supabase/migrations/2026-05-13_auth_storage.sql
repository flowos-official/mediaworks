-- 2026-05-13_auth_storage.sql
-- product-files bucket is currently public — keep it public for now (Phase 1).
-- Phase 5 will tighten via a follow-up if needed.
-- This migration documents intent and leaves room for future policies.

-- Ensure bucket exists with current public flag preserved.
insert into storage.buckets (id, name, public)
values ('product-files', 'product-files', true)
on conflict (id) do update set public = excluded.public;

-- (Intentionally no storage.objects policies in Phase 1 — relies on bucket-level public)
