# Whisper Chat

Build a private, minimal web messenger for exactly 4 pre-created users. It should feel like a stripped-down WhatsApp: clean, subtle, no extra clutter.

SUPABASE CONNECTION
- Supabase Project URL: https://ijulcjptlhxxhvmcqgde.supabase.co
- Supabase Anon Key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlqdWxjanB0bGh4eGh2bWNxZ2RlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3OTUzMjYsImV4cCI6MjEwNjM3MTMyNn0.Y9S9YGyUjHD4HpFrbJeuLmLXxsCqJIamsCyHjvLPOIc
- Provide a complete SQL migration script (e.g. in a supabase-setup.sql file or modal helper) containing the full schema, RLS policies, storage bucket 'chat-media', and automated user creation/seeding queries so the database can be initialized easily in Supabase SQL Editor.

AUTH
- No signup, no forgot password, no public registration. Admin creates the accounts.
- Login screen has only two fields: User ID and Password, and a single Sign in button.
- Use Supabase Auth. Map each User ID to an internal email "<userid>@chat.local". The user only ever types the User ID. Pad the password internally (e.g. append a fixed suffix like "_pad_secure") so short passwords like "00000" meet Supabase's 6-character minimum.
- 4 pre-created users: user1, user2, user3, user4, each with password 00000. Display names should be user1, user2, user3, user4.
- Keep the user logged in on that device (persistent session). Add a Logout button in the menu.
- Table "profiles": id, user_id, display_name, avatar_url, last_seen.

CHAT WINDOW (opens right after login as that user's account)
- WhatsApp-style two-pane layout. Left: list of the other 3 users with last message preview, time, unread badge, and online/offline dot. Right: the conversation.
- On mobile: list first, tap to open the conversation with a back button.
- Every user can chat with every other user (1-to-1 only, no groups).

MESSAGING FEATURES
- Realtime text messages using Supabase Realtime broadcast or postgres_changes.
- Send images: upload to Supabase Storage bucket 'chat-media', show thumbnail in chat, tap to view full size modal.
- Send voice notes: tap/hold to record using browser MediaRecorder, waveform or progress bar, play/pause, and duration display.
- Sent / delivered / read ticks, "typing..." indicator, online/last seen status.
- Full chat history stored in database, paginated / load older on scroll.
- Reply to message, delete for me / delete for everyone.
- Timestamps grouped by date (Today, Yesterday, date).

CALLING
- Voice call and video call buttons in the chat header.
- WebRTC peer-to-peer calling using Supabase Realtime channels for signalling (offer, answer, ICE candidates).
- Incoming call screen showing caller's name with Accept / Decline, plus audio ringtone.
- In-call controls: mute, camera on/off, switch camera, speaker, end call, and call timer.
- Log calls in chat as system messages (e.g. "Video call • 4:32" or "Missed call").
- Google's public STUN servers (stun:stun.l.google.com:19302), with ICE server configuration cleanly isolated so TURN can be added easily.

DATABASE & STORAGE (with Row Level Security)
- profiles: id, user_id, display_name, avatar_url, last_seen
- messages: id, sender_id, receiver_id, type (text/image/audio/call), content, media_url, reply_to, status (sent/delivered/read), created_at, deleted_for (array/jsonb), deleted_for_everyone (bool)
- calls: id, caller_id, receiver_id, type, status, started_at, ended_at
- Storage bucket "chat-media" with policies limiting access to chat participants.
- Before using view-once photos, apply `drizzle/migrations/0007_view_once_media.sql` to the connected Supabase database.

DESIGN & PWA
- Minimal, clean, neutral light theme with soft WhatsApp green accents and dark mode support.
- Responsive for mobile and desktop, installable as a PWA.
- Audio tones for incoming messages and calls, plus browser notification support.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://ontarioisp.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/2064648d-389f-41fe-8eff-6c20a52dca4e).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
