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

Videos without captions are kept in the We-Read index and recorded as
retryable transcript failures. Available English subtitles are preferred, then
translated by Terra low and stored as one Markdown article with Chinese first
and English second. To reduce full-agent overhead, adjacent captions are
coalesced into roughly 5,000-character segments and each Terra call is capped
at eight segments / 40,000 characters. Google fallback splits long segments
again before requesting translation. Local Whisper fallback is intentionally not
enabled in the first version because it downloads audio and model weights;
it will be added as an optional second-stage worker.
