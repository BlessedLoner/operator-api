-- ============================================================
-- StripPals: Paystack payments (additive migration)
-- ============================================================
-- What this does:
--   1. Adds a `payment_transactions` table: one row per checkout,
--      keyed by a unique payment reference.
--   2. Adds `grant_payment_credits(...)`, which locks that row,
--      checks the amount and currency, and calls the existing
--      `add_credits` function ONCE. Repeated webhooks or
--      verification calls for the same reference never add credits
--      twice.
--
-- What it does NOT do: it does not change, drop or delete any
-- existing table, row, balance, package or function.
--
-- How to run: Supabase dashboard -> SQL Editor -> paste this whole
-- file -> Run. It runs as one transaction: if any line fails
-- (for example an id type mismatch), nothing is applied.
-- ============================================================

begin;

create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'paystack',
  reference text not null unique,
  user_profile_id uuid not null references public.user_profiles (id),
  auth_user_id uuid not null,
  package_id uuid not null references public.credit_packages (id),
  credits integer not null,
  bonus_credits integer not null default 0,
  total_credits integer not null check (total_credits > 0),
  amount_subunit integer not null check (amount_subunit > 0),
  currency text not null,
  status text not null default 'initialized'
    check (status in ('initialized', 'pending', 'success', 'failed',
                      'abandoned', 'reversed', 'mismatch')),
  provider_transaction_id bigint,
  credited_at timestamptz,
  last_verification jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payment_transactions_user_profile_id_idx
  on public.payment_transactions (user_profile_id, created_at desc);

-- Only the backend (service role) may read or write payment rows.
-- RLS on with no policies = no access for anon/authenticated users.
alter table public.payment_transactions enable row level security;

create or replace function public.grant_payment_credits(
  p_reference text,
  p_amount_subunit integer,
  p_currency text,
  p_provider_transaction_id bigint,
  p_verification jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  tx public.payment_transactions%rowtype;
begin
  -- Lock the row so two concurrent calls for the same reference
  -- run one after the other.
  select * into tx
  from public.payment_transactions
  where reference = p_reference
  for update;

  if not found then
    return 'not_found';
  end if;

  if tx.credited_at is not null then
    return 'already_credited';
  end if;

  -- The verified payment must match what we charged for.
  if p_amount_subunit is distinct from tx.amount_subunit
     or upper(p_currency) is distinct from upper(tx.currency) then
    update public.payment_transactions
    set status = 'mismatch',
        provider_transaction_id = p_provider_transaction_id,
        last_verification = p_verification,
        updated_at = now()
    where id = tx.id;
    return 'mismatch';
  end if;

  perform public.add_credits(
    p_user_id => tx.user_profile_id,
    p_amount => tx.total_credits
  );

  update public.payment_transactions
  set status = 'success',
      credited_at = now(),
      provider_transaction_id = p_provider_transaction_id,
      last_verification = p_verification,
      updated_at = now()
  where id = tx.id;

  return 'credited';
end;
$$;

revoke all on function public.grant_payment_credits(text, integer, text, bigint, jsonb)
  from public, anon, authenticated;
grant execute on function public.grant_payment_credits(text, integer, text, bigint, jsonb)
  to service_role;

commit;
