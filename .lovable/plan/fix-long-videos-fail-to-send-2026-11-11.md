# Fix: long videos fail to send

## Likely cause
Uploads go to the private photo/video storage, which has a per-file size cap (default around 50 MB). Long phone videos are usually bigger, so the upload is rejected and nothing is sent.

## Changes
1. Raise the storage limit for chat media to the maximum allowed (up to 5 GB project-wide; set chat media to 1 GB).
2. Show a clear message when a file is still too large, instead of failing silently ("Video too large — max 1 GB").
3. Show upload progress for videos (percentage on the pending preview) so long uploads don't look stuck.
4. Large files use resumable upload so a weak connection doesn't restart from zero.

## Technical details
- `supabase--configure_storage` (global limit) + `supabase--storage_update_bucket(chat-media, file_size_limit="1GB")`.
- In Conversation.tsx `upload()`: pre-check size, surface storage error via toast; use TUS resumable upload (tus-js-client) for files > 6 MB with progress callback.
- Verify by uploading a ~100 MB test video in Playwright.
