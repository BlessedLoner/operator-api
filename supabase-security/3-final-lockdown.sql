-- =====================================================================
-- FINAL LOCKDOWN  -  run ONLY AFTER the new operator-api, operator-app
-- and manager-app are deployed and working. Run ONE section at a time and
-- do that section's tests (README.md) before the next. Undo: 4-final-undo.sql
-- =====================================================================


-- ---------------------------------------------------------------------
-- C1. Sign-up and "like" triggers run with owner rights, so they keep
--     adding users to the poke queue once the queue table is protected.
-- ---------------------------------------------------------------------
alter function public.add_new_user_to_poke_queue() security definer set search_path = public;
alter function public.add_liked_user_to_poke_queue() security definer set search_path = public;


-- ---------------------------------------------------------------------
-- C2. Staff-only tables: RLS on, no rules = only the backend (service
--     role) can use them. The new staff apps read them through the API.
-- ---------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array[
    'operator_accounts','managers','message_queue','stopped_queue',
    'operator_sessions','operator_actions','conversation_assignments',
    'outreach_daily_limits','outreach_history','flagged_messages',
    'operator_violations','reported_messages_log','blocked_fictional_log']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;


-- ---------------------------------------------------------------------
-- C3. Operator notes, photo logs and private photos: no more public access.
--     (Operators get these through the API; admins keep managing private
--     photos from the site's admin page.)
-- ---------------------------------------------------------------------
drop policy if exists "Operators can manage fictional logbook" on public.fictional_logbook;
drop policy if exists "Operators can manage user logbook" on public.user_logbook;
drop policy if exists "Operators can insert photo sent logs" on public.photo_sent_log;
drop policy if exists "Operators can view photo sent logs" on public.photo_sent_log;

alter table public.fictional_private_photos enable row level security;
drop policy if exists "Operators can view private photos" on public.fictional_private_photos;
create policy "Admins manage private photos" on public.fictional_private_photos
  for all to authenticated using (public.is_admin()) with check (public.is_admin());


-- ---------------------------------------------------------------------
-- C4. Messages and conversations: only the owner can read them.
--     (Existing "read own" rules stay, so users' chat and live updates work.)
-- ---------------------------------------------------------------------
drop policy if exists "operator_read_all_messages" on public.messages;
drop policy if exists "realtime_debug_messages" on public.messages;
drop policy if exists "TEMP read all conversations" on public.conversations;


-- ---------------------------------------------------------------------
-- C5. User profiles (incl. emails): users read only their own; admins all.
-- ---------------------------------------------------------------------
drop policy if exists "Allow limited profile reads" on public.user_profiles;
drop policy if exists "Allow reading user_profiles for joins" on public.user_profiles;
create policy "Admins read all profiles" on public.user_profiles
  for select to authenticated using (public.is_admin());
create policy "Admins update any profile" on public.user_profiles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());


-- ---------------------------------------------------------------------
-- C6. User tables that had RLS switched off.
-- ---------------------------------------------------------------------
-- Likes (users: own likes; admins: all, for the admin page)
alter table public.likes enable row level security;
create policy "users_update_own_likes" on public.likes for update to authenticated
  using (user_id in (select id from public.user_profiles where user_id = auth.uid()))
  with check (user_id in (select id from public.user_profiles where user_id = auth.uid()));
create policy "Admins read likes" on public.likes
  for select to authenticated using (public.is_admin());

-- Poke queue (the like button writes the user's own row)
alter table public.poke_queue enable row level security;
create policy "Users manage own poke row" on public.poke_queue for all to authenticated
  using (user_profile_id in (select id from public.user_profiles where user_id = auth.uid()))
  with check (user_profile_id in (select id from public.user_profiles where user_id = auth.uid()));

-- Blocks (users: own rules already exist; admins: all, for Admin Users)
alter table public.blocked_profiles enable row level security;
create policy "Admins manage blocks" on public.blocked_profiles
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Read markers (the site stores either the login id or the profile id here)
alter table public.conversation_reads enable row level security;
create policy "Users manage own read markers" on public.conversation_reads for all to authenticated
  using (user_id = auth.uid() or user_id in (select id from public.user_profiles where user_id = auth.uid()))
  with check (user_id = auth.uid() or user_id in (select id from public.user_profiles where user_id = auth.uid()));

-- Reports (insert rule already exists; let users see their own)
alter table public.reports enable row level security;
create policy "Users can read own reports" on public.reports for select to authenticated
  using (reporter_profile_id in (select id from public.user_profiles where user_id = auth.uid()));

-- Gallery photos (own-only rules already exist)
alter table public.user_gallery_photos enable row level security;

-- Prices and locations: everyone can read, only admins can change
alter table public.credit_packages enable row level security;
create policy "Public can view packages" on public.credit_packages
  for select to anon, authenticated using (true);

alter table public.states enable row level security;
create policy "Public can view states" on public.states
  for select to anon, authenticated using (true);

alter table public.cities enable row level security;
create policy "Public can view cities" on public.cities
  for select to anon, authenticated using (true);

alter table public.state_neighbors enable row level security;
create policy "Public can view state neighbors" on public.state_neighbors
  for select to anon, authenticated using (true);
create policy "Admins manage state neighbors" on public.state_neighbors
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
