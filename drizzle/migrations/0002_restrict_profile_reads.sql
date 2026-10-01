drop policy if exists "profiles read" on public.profiles;
drop policy if exists "profiles read approved chat members" on public.profiles;

create policy "profiles read approved chat members"
  on public.profiles
  for select
  to authenticated
  using (
    id = (select auth.uid())
    or lower(coalesce((select auth.jwt() ->> 'email'), '')) in (
      'jamie@chat.local',
      'cersi@chat.local',
      'tyrion@chat.local',
      'tywin@chat.local'
    )
  );