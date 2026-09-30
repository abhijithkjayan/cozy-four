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

- Backend is Lovable Cloud; schema via migrations; the 4 accounts are created idempotently by ensureAccounts server fn (called on failed login) since auth schema cannot be seeded in SQL.
- Realtime: postgres_changes for messages, broadcast channels `typing:<a>:<b>` and `call:<userId>` for typing and WebRTC signalling; ICE config isolated in src/lib/ice.ts so TURN can be added.
