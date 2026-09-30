-- Pin search_path on helper functions
alter function public.touch_product() set search_path = public;
alter function public.path_workspace(text) set search_path = public;

-- The signup trigger function should never be called directly through the API
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Membership helpers are only needed by signed-in users (row level security uses them)
revoke execute on function public.is_member(uuid) from public, anon;
revoke execute on function public.is_owner(uuid) from public, anon;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.is_owner(uuid) to authenticated;
