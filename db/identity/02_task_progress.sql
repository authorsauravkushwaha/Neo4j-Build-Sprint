-- ============================================================================
-- GraphMentor AI — roadmap task progress for account sync
--
-- Local progress is keyed by roadmap (or `career:<id>` before a roadmap is
-- saved) and, inside that, by task. The 001 roadmap_tasks table cannot hold
-- these rows: it requires a server-saved roadmap and a composite foreign key,
-- while most learners' progress exists before — or without — ever saving a
-- roadmap to the server. This table mirrors the local shape exactly so sync
-- is a faithful copy, not a lossy translation.
--
-- Owner-only RLS for the `authenticated` role, like every other user table;
-- the gm_auth sync policy is added in db/security/00_hardening.sql.
-- ============================================================================

create table if not exists public.user_task_progress (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  roadmap_key  text not null check (char_length(roadmap_key) between 1 and 200),
  task_key     text not null check (char_length(task_key) between 1 and 200),
  skill_id     text not null check (char_length(skill_id) <= 72),
  status       text not null check (status in ('not-started', 'in-progress', 'completed', 'needs-review')),
  actual_hours numeric(7, 2) check (actual_hours is null or (actual_hours >= 0 and actual_hours <= 10000)),
  notes        text check (notes is null or char_length(notes) <= 1000),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint user_task_progress_unique unique (user_id, roadmap_key, task_key)
);

create index if not exists user_task_progress_user_idx on public.user_task_progress (user_id);

comment on table public.user_task_progress is
  'Roadmap task statuses and logged hours as recorded on a device, synced verbatim (see /api/sync).';

drop trigger if exists gm_user_task_progress_touch on public.user_task_progress;
create trigger gm_user_task_progress_touch before update on public.user_task_progress
  for each row execute function public.gm_touch_updated_at();

alter table public.user_task_progress enable row level security;

drop policy if exists user_task_progress_all_own on public.user_task_progress;
create policy user_task_progress_all_own on public.user_task_progress
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);


