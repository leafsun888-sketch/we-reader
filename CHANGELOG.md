# Changelog

All notable changes to We-Read are documented here.

## 1.1.0 — 2026-08-10

- Added a Chrome 136+-compatible dedicated-browser launcher using a non-default profile.
- Bundled the standard-library article-to-Markdown converter under `fetcher/vendor/`.
- Added startup dependency checks, including detection of unusable macOS Xcode Python shims.
- Made refresh status truthful: export and Markdown archive failures now surface as failed or partial syncs.
- Replaced the placeholder web test with an HTTP integration test covering reader data, favorites, subscription, and archive-failure reporting.
- Added release, version, contribution, and maintenance documentation.

## 1.0.0 — 2026-08-07

- Initial public release of the local We-Read reader.
