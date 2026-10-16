-- ============================================================================
-- GraphMentor AI — rate limiting + replay protection (002)
--
-- Three SECURITY DEFINER functions, called only by Edge Functions with the
-- service-role key (see createPostgresFixedWindowStore / createPostgresNonceStore
-- in supabase/functions/_shared/platform/supabaseStore.ts).
--
-- Why in Postgres and not in memory:
--   Edge Functions are stateless and run in many isolates. An in-memory counter
--   limits one isolate, not a user. These tables make the limit global.
--
-- Threat model this file addresses:
--   * Credential stuffing / brute force on expensive endpoints -> fixed windows.
--   * Replay of a captured expensive request -> single-use nonces with TTL.
--   * Denial of service by growth -> cleanup function + TTL index.
--
-- Both tables are invisible to clients: RLS is enabled, no policies exist, and
-- EXECUTE on the functions is revoked from anon/authenticated. Even a leaked
-- anon key cannot read or inflate counters.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Fixed-window counters
-- ---------------------------------------------------------------------------
create table if not exists public.gm_rate_limit (
  key           text        not null,
  window_start  timestamptz not null,
  count         integer     not null default 0,
  primary key (key, window_start)
);

comment on table public.gm_rate_limit is
  'Fixed-window counters keyed by a hashed user id or hashed IP. Contains no raw identifiers and no personal data.';

create index if not exists gm_rate_limit_window_idx on public.gm_rate_limit (window_start);

alter table public.gm_rate_limit enable row level security;

-- Functions must see the table even though no policy grants access to clients;
-- SECURITY DEFINER runs them as the function owner (postgres), which bypasses RLS.
create or replace function public.gm_consume_rate_limit(
  p_key text,
  p_window_seconds integer,
  p_limit integer
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window  timestamptz;
  v_count   integer;
  v_seconds integer := greatest(1, least(coalesce(p_window_seconds, 60), 86400));
  v_limit   integer := greatest(1, least(coalesce(p_limit, 60), 1000000));
begin
  if p_key is null or char_length(p_key) < 4 or char_length(p_key) > 200 then
    raise exception 'invalid rate-limit key' using errcode = '22023';
  end if;

  -- Anchor the window to the epoch so every isolate computes the same bucket.
  v_window := to_timestamp(floor(extract(epoch from now()) / v_seconds) * v_seconds);

  insert into public.gm_rate_limit as rl (key, window_start, count)
  values (p_key, v_window, 1)
  on conflict (key, window_start)
    do update set count = least(rl.count + 1, 1000000)
  returning rl.count into v_count;

  -- Return the *uncapped* comparison as a plain count; the caller decides what
  -- to do with it. Never leak the configured limit through an error message.
  return least(v_count, v_limit + 1);
end;
$$;

comment on function public.gm_consume_rate_limit(text, integer, integer) is
  'Atomically increments the counter for the current window and returns the new count (capped at limit+1). Fails with 22023 on a malformed key.';

-- ---------------------------------------------------------------------------
-- Single-use nonces (replay protection for signed requests)
-- ---------------------------------------------------------------------------
create table if not exists public.gm_nonce (
  nonce      text        primary key check (char_length(nonce) between 8 and 200),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

comment on table public.gm_nonce is
  'Claimed request nonces. A primary-key insert is what makes a replay impossible: the second attempt conflicts.';

create index if not exists gm_nonce_expiry_idx on public.gm_nonce (expires_at);

alter table public.gm_nonce enable row level security;

create or replace function public.gm_claim_nonce(
  p_nonce text,
  p_ttl_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ttl  integer := greatest(30, least(coalesce(p_ttl_seconds, 300), 86400));
  v_rows integer;
begin
  if p_nonce is null or char_length(p_nonce) < 8 or char_length(p_nonce) > 200 then
    raise exception 'invalid nonce' using errcode = '22023';
  end if;

  insert into public.gm_nonce (nonce, expires_at)
  values (p_nonce, now() + make_interval(secs => v_ttl))
  on conflict (nonce) do nothing;

  get diagnostics v_rows = row_count;
  -- true  = this request claimed the nonce (fresh),
  -- false = it was already used (replay).
  return v_rows = 1;
end;
$$;

comment on function public.gm_claim_nonce(text, integer) is
  'Claims a nonce exactly once. Returns true for the first call and false for every replay of the same value.';

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------
create or replace function public.gm_cleanup_rate_limit(p_days integer default 1)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cutoff timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 1), 90)));
  v_removed integer := 0;
  v_batch integer;
begin
  -- Delete in bounded batches so a large backlog cannot hold a long lock.
  loop
    with doomed as (
      select ctid from public.gm_rate_limit
      where window_start < v_cutoff
      limit 5000
    )
    delete from public.gm_rate_limit rl
    using doomed
    where rl.ctid = doomed.ctid;
    get diagnostics v_batch = row_count;
    v_removed := v_removed + v_batch;
    exit when v_batch < 5000;
  end loop;

  delete from public.gm_nonce where expires_at < now();

  return v_removed;
end;
$$;

comment on function public.gm_cleanup_rate_limit(integer) is
  'Deletes expired counters and nonces in bounded batches. Safe to schedule hourly via pg_cron.';

-- ---------------------------------------------------------------------------
-- Lock the helper tables away from every client role
-- ---------------------------------------------------------------------------
revoke all on table public.gm_rate_limit from anon, authenticated;
revoke all on table public.gm_nonce from anon, authenticated;

revoke execute on function public.gm_consume_rate_limit(text, integer, integer) from public, anon, authenticated;
revoke execute on function public.gm_claim_nonce(text, integer) from public, anon, authenticated;
revoke execute on function public.gm_cleanup_rate_limit(integer) from public, anon, authenticated;

grant execute on function public.gm_consume_rate_limit(text, integer, integer) to service_role;
grant execute on function public.gm_claim_nonce(text, integer) to service_role;
grant execute on function public.gm_cleanup_rate_limit(integer) to service_role;

-- Optional: let the scheduler call cleanup instead of the app.
--   select cron.schedule('gm_cleanup_rate_limit', '17 * * * *', $$select public.gm_cleanup_rate_limit(1)$$);
-- Commented out on purpose: enabling pg_cron is a project-level decision.

-- ============================================================================
-- Verification queries (run manually after `supabase db push`):
--
--   -- 1. Every user table must have RLS on:
--   select relname, relrowsecurity from pg_class
--   where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname;
--
--   -- 2. No anonymous access to the helper tables:
--   select has_table_privilege('anon', 'public.gm_rate_limit', 'select');   -- expect false
--   select has_function_privilege('anon', 'public.gm_claim_nonce(text, integer)', 'execute'); -- expect false
--
--   -- 3. The conflict targets used by the API exist:
--   select conname from pg_constraint
--   where conrelid in ('public.roadmap_tasks'::regclass, 'public.saved_roadmaps'::regclass)
--   order by conname;
-- ============================================================================


