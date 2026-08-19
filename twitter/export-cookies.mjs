#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectChrome } from '../fetcher/lib/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.dirname(HERE);
const PROFILE_DIR = path.join(PROJECT, 'data', '浏览器', 'chrome-twitter');
const COOKIE_FILE = path.join(PROJECT, 'data', '数据', 'twitter-cookies.json');
const TWITTER_DOMAINS = new Set(['x.com', '.x.com', 'twitter.com', '.twitter.com']);

async function main() {
  const session = await connectChrome({
    port: 9223,
    profileDir: PROFILE_DIR,
    autoLaunch: false,
  });
  try {
    const { cookies = [] } = await session.send('Storage.getCookies');
    const selected = cookies.filter((cookie) => TWITTER_DOMAINS.has(cookie.domain));
    const cookieMap = Object.fromEntries(selected.map((cookie) => [cookie.name, cookie.value]));
    if (!cookieMap.auth_token || !cookieMap.ct0) {
      throw new Error('专用 X Chrome 还没有完整登录：未找到 auth_token/ct0。');
    }

    fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
    const temporary = `${COOKIE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(cookieMap, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, COOKIE_FILE);
    fs.chmodSync(COOKIE_FILE, 0o600);
    process.stdout.write(`X 登录态已保存（${Object.keys(cookieMap).length} 个 Cookie）。\n`);
  } finally {
    session.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
