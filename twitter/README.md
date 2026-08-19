# Twitter integration

This directory provides low-volume public-account subscriptions for We-Read.
It never reads the WeChat Chrome profile and never posts, likes, messages, or
follows through the user's X account. A separate `chrome-twitter` profile may be
used for authenticated, read-only timelines because the logged-out X timeline
can be stale.

## Setup

```bash
cd twitter
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

## Probe a public account

```bash
cd twitter
.venv/bin/python probe.py NASA --count 3
```

The command prints JSON to stdout and does not persist fetched data.

## Resolve, subscribe, and sync

```bash
cd twitter
.venv/bin/python sync.py resolve @karpathy --count 5
.venv/bin/python sync.py subscribe @karpathy --initial-limit 10
.venv/bin/python sync.py sync --max-new 20 --delay 5
```

## Agent value gate

Every new candidate is reviewed by Terra with medium reasoning before
translation or archiving. Only `keep` decisions enter the library. The gate is
fail-closed: an incomplete agent result stops that sync instead of allowing
unreviewed tweets through. It does not use keyword or engagement thresholds as
a substitute for reading the tweet.

```bash
.venv/bin/python value_filter.py --account karpathy --limit 20
.venv/bin/python sync.py backfill-value-gate --account karpathy --limit 20
```

The first command is a read-only preview. The second audits legacy items;
filtered Markdown is retained in recoverable quarantine metadata rather than
silently destroyed.

Subscriptions and status are private local files under `data/数据/`. Tweets are
merged into the shared library and archived under `data/文章/Twitter/`.

## Why there is a compatibility layer

Twikit 2.3.3 predates X's 2026 logged-out frontend. Its GuestClient currently
fails while generating `x-client-transaction-id`, before the actual guest
request is sent. X's guest activation endpoint still accepts a normal browser-
shaped request without that header. X also omits some empty model fields that
Twikit assumes always exist. `compat.py` narrowly handles those two read-only
differences without modifying the installed Twikit package.

## Authenticated read-only timeline

Start Chrome with the dedicated profile on port 9223, log in to X, then run:

```bash
node twitter/export-cookies.mjs
```

The exporter writes only X-domain cookies to
`data/数据/twitter-cookies.json` with mode `0600`. It never prints their values.
`sync.py` refreshes this file when the dedicated Chrome is open and otherwise
reuses the last saved session. If no valid login cookie exists, it falls back to
the guest reader.

Do not use this integration for posting, following, messaging, bulk scraping,
or rapid polling. Keep the profile and cookie file under the private project
`data/` tree and never commit or print them.
