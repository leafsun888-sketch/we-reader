# Changelog

All notable changes to We-Read are documented here.

## 1.2.0 — 2026-10-14

- Fetch WeChat article bodies through the authenticated WeRead content endpoint; preserve manual verification and access restrictions.
- Resolve WR1 identifiers to canonical WeChat original URLs instead of constructing invalid short links.
- Add separately locked, quota-free archive-only and original-URL-repair operations, with recoverable JSON backups.
- Preserve long article titles and existing archive directories; repair local image references and reject incomplete repost cards.
- Add Xiaoyuzhou subscriptions, local transcription, readable manuscripts and a dedicated tab/group.
- Update YouTube manuscripts and summaries, Twitter person/frequency filters and original-language reading, and persistent favorites.
- Keep release paths portable and all private libraries, credentials, browser profiles and runtime outputs excluded.

## 1.1.0 — 2026-08-10

- Added a Chrome 136+-compatible dedicated-browser launcher using a non-default profile.
- Bundled the standard-library article-to-Markdown converter under `fetcher/vendor/`.
- Added startup dependency checks, including detection of unusable macOS Xcode Python shims.
- Made refresh status truthful: export and Markdown archive failures now surface as failed or partial syncs.
- Replaced the placeholder web test with an HTTP integration test covering reader data, favorites, subscription, and archive-failure reporting.
- Added release, version, contribution, and maintenance documentation.

## 1.0.0 — 2026-08-07

- Initial public release of the local We-Read reader.
