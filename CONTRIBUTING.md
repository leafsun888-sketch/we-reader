# Contributing and maintenance

## Before opening an issue

- State your We-Read version, OS, Chrome version, and the exact visible error.
- Remove article text, article URLs if sensitive, account names, cookies, `config.json`, `data/`, and browser profile contents.
- Never request or attach QR-login sessions, passwords, or CAPTCHA material.

## Before a release

1. Update `VERSION`, both `package.json` versions, and `CHANGELOG.md`.
2. Run `./start.sh --check`, `npm test --prefix app`, and `npm test --prefix fetcher`.
3. Check `git status` (or the GitHub file list) for private data. `data/`, `fetcher/config.json`, and `fetcher/data/` must never be included.
4. Publish a tagged GitHub Release named `vX.Y.Z`, with a concise summary and the validation commands used.

## Support scope

We maintain local reading, low-frequency updates, and correct error reporting. We do not support bypassing platform verification, CAPTCHA, access controls, or high-volume scraping.
