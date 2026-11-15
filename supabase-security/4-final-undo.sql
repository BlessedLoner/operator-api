-- =====================================================================
-- UNDO for 3-final-lockdown.sql. Run only the section that broke something.
-- Policies below are recreated exactly as they were (from your policy list).
-- =====================================================================

-- ---- Undo C1 ----
alter function public.add_new_user_to_poke_queue() security invoker;
alter function public.add_liked_user_to_poke_queue() security invoker;

-- ---- Undo C2 ----
do $$ declare t text; begin
  foreach t in array array[
    'operator_accounts','managers','message_queue','stopped_queue',
    'operator_sessions','operator_actions','conversation_assignments',
    'outreach_daily_limits','outreach_history','flagged_messages',
    'operator_violations','reported_messages_log','blocked_fictional_log']
  loop
    execute format('alter table public.%I disable row level security', t);
    execute format('grant select on public.%I to anon, authenticated', t);
  end loop;
end $$;
-- (operator_accounts: then re-run section B of 2-batch2-lockdown.sql to hide password_hash again)

-- ---- Undo C3 ----
create policy "Operators can manage fictional logbook" on public.fictional_logbook for all to public using (true);
create policy "Operators can manage user logbook" on public.user_logbook for all to public using (true);
create policy "Operators can insert photo sent logs" on public.photo_sent_log for insert to public with check (true);
create policy "Operators can view photo sent logs" on public.photo_sent_log for select to public using (true);
drop policy if exists "Admins manage private photos" on public.fictional_private_photos;
create policy "Operators can view private photos" on public.fictional_private_photos for select to public using (true);
alter table public.fictional_private_photos disable row level security;

-- ---- Undo C4 ----
create policy "operator_read_all_messages" on public.messages for select to public using (true);
create policy "realtime_debug_messages" on public.messages for select to public using (true);
create policy "TEMP read all conversations" on public.conversations for select to public using (true);

-- ---- Undo C5 ----
drop policy if exists "Admins read all profiles" on public.user_profiles;
drop policy if exists "Admins update any profile" on public.user_profiles;
create policy "Allow limited profile reads" on public.user_profiles for select to public using (true);
create policy "Allow reading user_profiles for joins" on public.user_profiles for select to public using (true);

-- ---- Undo C6 (each table can be undone on its own) ----
alter table public.likes disable row level security;
alter table public.poke_queue disable row level security;
alter table public.blocked_profiles disable row level security;
alter table public.conversation_reads disable row level security;
alter table public.reports disable row level security;
alter table public.user_gallery_photos disable row level security;
alter table public.credit_packages disable row level security;
alter table public.states disable row level security;
alter table public.cities disable row level security;
alter table public.state_neighbors disable row level security;
