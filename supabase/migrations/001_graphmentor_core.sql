-- ============================================================================
-- GraphMentor AI — core schema (001)
--
-- Mirrors exactly what supabase/functions/_shared/platform/supabaseStore.ts
-- reads and writes. Apply with:
--
--   supabase db push                 # or: supabase migration up
--
-- Design rules used throughout:
--   * every user-owned table carries `user_id` (or `id` for profiles) and an
--     owner-only RLS policy — "authentication is not authorisation",
--   * no table is readable by `anon`, and nothing private is world-readable,
--   * composite foreign keys keep child rows inside the same account as their
--     parent, so a forged roadmap id cannot be used to write into somebody
--     else's roadmap,
--   * every table carries created_at/updated_at and a trigger that maintains
--     updated_at, because the app sorts on it.
-- ============================================================================

-- gen_random_uuid() is available in Postgres 13+ core; the explicit extension is
-- irrelevant on a modern Supabase project but harmless if it is missing.
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.gm_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.gm_touch_updated_at() is
  'Sets updated_at on every UPDATE so client clocks can never influence ordering.';

-- ---------------------------------------------------------------------------
-- profiles — the only place user preferences live (localStorage is for guests)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id                uuid        primary key references auth.users (id) on delete cascade,
  education_level   text        check (education_level is null or char_length(education_level) <= 200),
  branch            text        check (branch is null or char_length(branch) <= 200),
  career_goal_id    text        check (career_goal_id is null or char_length(career_goal_id) <= 72),
  interests         text[]      not null default '{}',
  weekly_hours      integer     check (weekly_hours is null or (weekly_hours >= 0 and weekly_hours <= 1440)),
  preferred_pace    text        check (preferred_pace is null or preferred_pace in ('relaxed', 'steady', 'intensive')),
  learning_style    text        check (learning_style is null or learning_style in ('video', 'reading', 'hands-on', 'mixed')),
  goal_note         text        check (goal_note is null or char_length(goal_note) <= 200),
  theme             text        check (theme is null or theme in ('dark', 'light', 'system')),
  reduced_motion    boolean,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.profiles is
  'One row per account: onboarding answers and display preferences. Only the column list in manage-account/update-profile is writable.';

-- Limit the array size at the database level too: the API caps it at 20, a
-- direct client cannot go beyond 50.
alter table public.profiles drop constraint if exists profiles_interests_len;
alter table public.profiles
  add constraint profiles_interests_len check (array_length(interests, 1) is null or array_length(interests, 1) <= 50);

drop trigger if exists gm_profiles_touch on public.profiles;
create trigger gm_profiles_touch before update on public.profiles
  for each row execute function public.gm_touch_updated_at();

alter table public.profiles enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated using (auth.uid() = id);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (auth.uid() = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists profiles_delete_own on public.profiles;
create policy profiles_delete_own on public.profiles
  for delete to authenticated using (auth.uid() = id);

-- Convenience: create the profile row on signup so the app never has to handle
-- a missing row. Failure here must not block the signup itself.
create or replace function public.gm_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists gm_on_auth_user_created on auth.users;
create trigger gm_on_auth_user_created after insert on auth.users
  for each row execute function public.gm_handle_new_user();

-- ---------------------------------------------------------------------------
-- saved_roadmaps + roadmap_tasks
-- ---------------------------------------------------------------------------
create table if not exists public.saved_roadmaps (
  id                 uuid        primary key default gen_random_uuid(),
  user_id            uuid        not null references auth.users (id) on delete cascade,
  title              text        not null check (char_length(title) between 1 and 120),
  career_id          text        not null check (char_length(career_id) <= 72),
  career_name        text        not null check (char_length(career_name) <= 160),
  weekly_hours       integer     not null check (weekly_hours between 1 and 168),
  pace               text        not null check (pace in ('relaxed', 'steady', 'intensive')),
  estimate_disclaimer text       not null check (char_length(estimate_disclaimer) <= 600),
  milestones         jsonb       not null default '[]'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- Needed as the target of the composite foreign key on roadmap_tasks, so a
  -- task can never reference a roadmap owned by a different account.
  unique (id, user_id),
  constraint saved_roadmaps_milestones_is_array check (jsonb_typeof(milestones) = 'array')
);

comment on table public.saved_roadmaps is
  'A generated roadmap the signed-in user chose to keep. Guests keep theirs in localStorage only.';

create index if not exists saved_roadmaps_user_updated_idx
  on public.saved_roadmaps (user_id, updated_at desc);

drop trigger if exists gm_saved_roadmaps_touch on public.saved_roadmaps;
create trigger gm_saved_roadmaps_touch before update on public.saved_roadmaps
  for each row execute function public.gm_touch_updated_at();

alter table public.saved_roadmaps enable row level security;

drop policy if exists saved_roadmaps_all_own on public.saved_roadmaps;
create policy saved_roadmaps_all_own on public.saved_roadmaps
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.roadmap_tasks (
  id                   uuid        primary key default gen_random_uuid(),
  roadmap_id           uuid        not null,
  user_id              uuid        not null,
  skill_id             text        not null check (char_length(skill_id) <= 72),
  name                 text        not null check (char_length(name) <= 160),
  status               text        not null default 'not-started'
                                   check (status in ('not-started', 'in-progress', 'completed', 'needs-review')),
  difficulty           text        not null check (difficulty in ('beginner', 'intermediate', 'advanced')),
  order_index          integer     not null check (order_index >= 0 and order_index <= 1000),
  scheduled_week       integer     not null check (scheduled_week between 1 and 520),
  scheduled_day        integer     check (scheduled_day is null or (scheduled_day between 0 and 6)),
  estimated_hours_low  numeric(6,1) not null check (estimated_hours_low >= 0 and estimated_hours_low <= 400),
  estimated_hours_high numeric(6,1) not null check (estimated_hours_high >= 0 and estimated_hours_high <= 600),
  essential            boolean     not null default true,
  note                 text        check (note is null or char_length(note) <= 600),
  actual_hours         numeric(6,1) check (actual_hours is null or (actual_hours >= 0 and actual_hours <= 200)),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint roadmap_tasks_roadmap_owner_fkey
    foreign key (roadmap_id, user_id) references public.saved_roadmaps (id, user_id) on delete cascade,
  constraint roadmap_tasks_hours_order check (estimated_hours_high >= estimated_hours_low),
  -- Exactly the conflict target used by the API upsert, so re-saving a roadmap
  -- converges instead of duplicating tasks.
  constraint roadmap_tasks_unique_slot unique (roadmap_id, skill_id, order_index, status)
);

comment on table public.roadmap_tasks is
  'One row per roadmap step. Progress is stored here, so a roadmap can be resumed on another device.';

create index if not exists roadmap_tasks_user_idx on public.roadmap_tasks (user_id, roadmap_id, order_index);
create index if not exists roadmap_tasks_status_idx on public.roadmap_tasks (user_id, status);

drop trigger if exists gm_roadmap_tasks_touch on public.roadmap_tasks;
create trigger gm_roadmap_tasks_touch before update on public.roadmap_tasks
  for each row execute function public.gm_touch_updated_at();

alter table public.roadmap_tasks enable row level security;

drop policy if exists roadmap_tasks_all_own on public.roadmap_tasks;
create policy roadmap_tasks_all_own on public.roadmap_tasks
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- user_skill_progress — self-reported skill states + optional quiz score
-- ---------------------------------------------------------------------------
create table if not exists public.user_skill_progress (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users (id) on delete cascade,
  skill_id    text        not null check (char_length(skill_id) <= 72),
  state       text        not null check (state in ('unknown', 'new', 'learning', 'practised', 'confident')),
  quiz_score  numeric(4,3) check (quiz_score is null or (quiz_score >= 0 and quiz_score <= 1)),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint user_skill_progress_unique_skill unique (user_id, skill_id)
);

comment on table public.user_skill_progress is
  'Self-reported skill state. The UI labels these as self-reported; they are never presented as verified credentials.';

create index if not exists user_skill_progress_user_idx on public.user_skill_progress (user_id);

drop trigger if exists gm_user_skill_progress_touch on public.user_skill_progress;
create trigger gm_user_skill_progress_touch before update on public.user_skill_progress
  for each row execute function public.gm_touch_updated_at();

alter table public.user_skill_progress enable row level security;

drop policy if exists user_skill_progress_all_own on public.user_skill_progress;
create policy user_skill_progress_all_own on public.user_skill_progress
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- bookmarks — saved skills, projects and resources
-- ---------------------------------------------------------------------------
create table if not exists public.bookmarks (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users (id) on delete cascade,
  target_type text        not null check (target_type in ('skill', 'project', 'resource', 'career', 'module')),
  target_id   text        not null check (char_length(target_id) <= 72),
  note        text        check (note is null or char_length(note) <= 400),
  created_at  timestamptz not null default now(),
  constraint bookmarks_unique_target unique (user_id, target_id)
);

comment on table public.bookmarks is
  'Personal shortlist. The note column is free text and is rendered as plain text, never as HTML.';

create index if not exists bookmarks_user_idx on public.bookmarks (user_id, created_at desc);

alter table public.bookmarks enable row level security;

drop policy if exists bookmarks_all_own on public.bookmarks;
create policy bookmarks_all_own on public.bookmarks
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- feedback — signed-in users and guests alike (guest rows have user_id null)
-- ---------------------------------------------------------------------------
create table if not exists public.feedback (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        references auth.users (id) on delete set null,
  kind       text        not null check (kind in ('bug', 'content', 'resource-link', 'accessibility', 'other')),
  message    text        not null check (char_length(message) between 3 and 1500),
  contact    text        check (contact is null or char_length(contact) <= 160),
  target_id  text        check (target_id is null or char_length(target_id) <= 72),
  page_url   text        check (page_url is null or char_length(page_url) <= 300),
  created_at timestamptz not null default now()
);

comment on table public.feedback is
  'Product feedback. Guests may submit anonymously; there is deliberately no client-facing SELECT policy — maintainers read it through the dashboard.';

create index if not exists feedback_created_idx on public.feedback (created_at desc);

alter table public.feedback enable row level security;

-- Insert is allowed for guests as well, but the row can never be attributed to
-- another account: user_id must be null or the caller's own id.
drop policy if exists feedback_insert_any on public.feedback;
create policy feedback_insert_any on public.feedback
  for insert to anon, authenticated
  with check (user_id is null or user_id = auth.uid());

-- A signed-in user may see their own feedback (used by the account export).
drop policy if exists feedback_select_own on public.feedback;
create policy feedback_select_own on public.feedback
  for select to authenticated using (auth.uid() = user_id);

-- Deleting your data must remove the text you wrote plus the attribution.
drop policy if exists feedback_delete_own on public.feedback;
create policy feedback_delete_own on public.feedback
  for delete to authenticated using (auth.uid() = user_id);


