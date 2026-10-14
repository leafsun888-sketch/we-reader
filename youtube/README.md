# We-Read YouTube integration

This module keeps YouTube work isolated from the WeChat fetcher. It uses
YouTube's channel RSS feed for low-cost incremental discovery, `yt-dlp` for
channel resolution/fallback discovery, and `youtube-transcript-api` for
captions. No YouTube API key or login cookie is required for public channels.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt

# Resolve without writing
.venv/bin/python sync.py resolve "https://www.youtube.com/@NASA"

# Register a channel (does not fetch transcripts yet)
.venv/bin/python sync.py subscribe "https://www.youtube.com/@NASA" --initial-limit 5

# Incremental discovery + English transcript archive + Chinese translation
.venv/bin/python sync.py sync --max-new 10 --delay 60

# Repair missing publish times and align archive folder dates
.venv/bin/python sync.py backfill-metadata --delay 1
```

Videos without captions remain in the index with retryable transcript failures.
Available English subtitles are preferred and saved locally. Terra medium
generates a paragraph-based Chinese manuscript, aiming to preserve information
and sentence order while repairing subtitle fragmentation. Terra high generates
a one-paragraph summary. Chinese text appears before the original English
transcript, with links to the source video. Model calls require a logged-in
Codex CLI and consume its configured account quota. YouTube audio-to-Whisper
fallback is not enabled.
