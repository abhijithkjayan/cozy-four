# Fix "Clear chat for everyone" and pinning

## Cause (confirmed in the database)
The app code expects two pin fields on messages (pinned time and who pinned it), plus an alert-change time on profiles. Those were written in files 0014 and 0015 but never applied to the live database. So:
- Pin / Unpin a message fails, because the pin field doesn't exist.
- "Clear chat for everyone" fails, because it also clears the pin field.

## Fix
1. Add the missing fields to the database, same as files 0014 and 0015: messages pinned_at, pinned_by (linked to profiles), a pinned index; profiles telegram_alerts_changed_at. Then reload the schema cache.
2. Check that the fields now exist.
3. In the preview, sign in and test three things: pin a message, unpin it, and clear chat for everyone. Also pin a chat from the chat list.
4. No app code changes unless the tests show another error.
