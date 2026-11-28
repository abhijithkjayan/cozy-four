# WhatsApp-style video compression

## Current state
The app already shrinks videos before sending, but only when a video is over 50 MB, and it keeps them at full HD (about 6 Mbps). Most long videos are still big and slow to send.

## Changes
1. Compress any video over about 16 MB, or longer than about 1 minute, before sending.
2. Use WhatsApp-like quality: up to 720p, about 1.5–2 Mbps video and normal audio. A 5-minute video becomes roughly 60–75 MB instead of several hundred.
3. Keep the original shape (portrait stays portrait).
4. Keep the "Send uncompressed" tick box for when you want full quality.
5. Show "Compressing NN%" on the preview while it works, then upload.
6. If compression fails on a device, send the original as now (up to 1 GB).

## Technical details
- `src/lib/media-compress.ts`: lower `CHAT_VIDEO_LIMIT_BYTES` to 16 MB, add a duration check, add a chat profile (long edge 1280, ~0.06 bits/pixel, capped ~2 Mbps) separate from the Telegram fit-to-size path.
- No database or server changes.
- Verify with a test long video in the browser: output smaller, plays, correct ratio.
