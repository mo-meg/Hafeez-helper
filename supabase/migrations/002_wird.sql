-- Wird Planner: allow the two new synced tables. Run once in the Supabase SQL editor
-- (safe to re-run) BEFORE deploying a build that contains the Wird Planner; otherwise the
-- server rejects pushes of Wird plans/tasks and sync reports an error.
alter table public.user_records drop constraint if exists user_records_tbl_check;
alter table public.user_records add constraint user_records_tbl_check
  check (tbl in ('mistakes', 'reviews', 'mistakeEvents', 'plans', 'sessions', 'wirdPlans', 'wirdTasks', 'settings'));
