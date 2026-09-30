<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Backend is the user's own Supabase project (URL + anon key in src/lib/supabase.ts); schema lives in supabase-setup.sql, run manually in the SQL Editor — keeps setup to one paste.
- Realtime: postgres_changes for messages, broadcast channels `typing:<a>:<b>` and `call:<userId>` for typing and WebRTC signalling; ICE config isolated in src/lib/ice.ts so TURN can be added.
