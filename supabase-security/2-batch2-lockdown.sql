-- =====================================================================
-- BATCH 2  -  run BEFORE deploying the new operator-api
-- Safe with the CURRENT (old) apps still live. Read README.md first.
-- =====================================================================

-- A. Credit/message functions: the website can no longer call them.
--    (The backend uses the service-role key and still can.)
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in (
             'add_credits','send_user_message','deduct_credits_on_message',
             'fn_messages_charge_credits','fn_deduct_credits_on_message',
             'fn_credit_topup','queue_user_message')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- B. Operator accounts: hide password_hash, no edits from the website.
--    The old operator-app still reads is_active / operator_type, and the old
--    manager-app still reads names, so those columns stay readable for now.
revoke all on public.operator_accounts from anon, authenticated;
grant select (id, username, full_name, email, operator_type, is_active)
  on public.operator_accounts to anon, authenticated;

-- C. Nobody can add/edit managers, prices or staff/queue data from the website.
revoke insert, update, delete, truncate on
  public.managers, public.credit_packages, public.message_queue, public.stopped_queue,
  public.operator_sessions, public.operator_actions, public.conversation_assignments,
  public.outreach_daily_limits, public.outreach_history, public.reported_messages_log,
  public.blocked_fictional_log, public.cities, public.states
from anon, authenticated;


-- =====================================================================
-- UNDO (only if something breaks)
-- =====================================================================
-- grant all on public.operator_accounts, public.managers, public.credit_packages,
--   public.message_queue, public.stopped_queue, public.operator_sessions, public.operator_actions,
--   public.conversation_assignments, public.outreach_daily_limits, public.outreach_history,
--   public.reported_messages_log, public.blocked_fictional_log, public.cities, public.states
-- to anon, authenticated;
--
-- do $$ declare f regprocedure; begin
--   for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--            where n.nspname = 'public' and p.proname in (
--              'add_credits','send_user_message','deduct_credits_on_message',
--              'fn_messages_charge_credits','fn_deduct_credits_on_message',
--              'fn_credit_topup','queue_user_message')
--   loop execute format('grant execute on function %s to anon, authenticated', f); end loop;
-- end $$;
