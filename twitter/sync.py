#!/usr/bin/env python3
"""Low-volume Twitter/X subscriptions and local Markdown archiving for We-Read."""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import email.utils
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from compat import CompatibleAuthenticatedClient, CompatibleGuestClient, USER_AGENT


PROJECT = Path(__file__).resolve().parent.parent
DEFAULT_DATA = PROJECT / "data"
SCREEN_NAME = re.compile(r"^[A-Za-z0-9_]{1,15}$")
TWITTER_HOSTS = {"x.com", "www.x.com", "twitter.com", "www.twitter.com"}
TRANSLATION_SCHEMA = Path(__file__).with_name("translation.schema.json")
PRESENTATION_SCHEMA = Path(__file__).with_name("presentation.schema.json")
VALUE_FILTER_SCHEMA = Path(__file__).with_name("value-filter.schema.json")
TERRA_MODEL = "gpt-5.6-terra"
TERRA_PROVIDER = f"{TERRA_MODEL}/low"
PRESENTATION_PROVIDER = TERRA_PROVIDER
VALUE_FILTER_PROVIDER = f"{TERRA_MODEL}/medium"
VALUE_FILTER_VERSION = 1
LONG_TWEET_WORD_THRESHOLD = 500
HIGH_FREQUENCY_WINDOW_DAYS = 14
LOW_FREQUENCY_WINDOW_DAYS = 60
MAX_TIMELINE_PAGES = 30
MAX_TIMELINE_ITEMS = 600
COOKIE_EXPORT = Path(__file__).with_name("export-cookies.mjs")


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def paths(data_root: Path) -> dict[str, Path]:
    return {
        "subscriptions": data_root / "数据" / "twitter-subscriptions.json",
        "status": data_root / "数据" / "twitter-status.json",
        "library": data_root / "数据" / "library.json",
        "cookies": data_root / "数据" / "twitter-cookies.json",
    }


def authenticated_cookie_map(cookie_file: Path | None) -> dict[str, str] | None:
    if not cookie_file:
        return None
    cookies = read_json(cookie_file, {})
    if not isinstance(cookies, dict) or not cookies.get("auth_token") or not cookies.get("ct0"):
        return None
    return {str(key): str(value) for key, value in cookies.items() if value is not None}


def refresh_browser_cookies(data_root: Path) -> bool:
    """Refresh the private cookie file when the dedicated X Chrome is open."""
    node = shutil.which("node") or str(Path.home() / ".local" / "bin" / "node")
    if not COOKIE_EXPORT.exists() or not Path(node).exists():
        return False
    try:
        result = subprocess.run(
            [node, str(COOKIE_EXPORT)], cwd=PROJECT, capture_output=True,
            text=True, timeout=12, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0 and authenticated_cookie_map(paths(data_root)["cookies"]) is not None


def normalize_screen_name(value: str) -> str:
    value = value.strip()
    if value.startswith("@"): value = value[1:]
    if "://" in value:
        parsed = urllib.parse.urlparse(value)
        if parsed.scheme not in {"http", "https"} or parsed.hostname not in TWITTER_HOSTS:
            raise ValueError("请输入 @用户名或 x.com 用户主页链接")
        value = parsed.path.strip("/").split("/", 1)[0]
    if not SCREEN_NAME.fullmatch(value):
        raise ValueError("Twitter 用户名应为 1-15 位字母、数字或下划线")
    return value


def snowflake_timestamp(tweet_id: str) -> int:
    try:
        return ((int(tweet_id) >> 22) + 1288834974657) // 1000
    except (TypeError, ValueError):
        return 0


def parse_created_at(value: str, tweet_id: str) -> int:
    try:
        parsed = email.utils.parsedate_to_datetime(value)
        return int(parsed.timestamp())
    except (TypeError, ValueError):
        return snowflake_timestamp(tweet_id)


def compact_text(value: str, limit: int = 220) -> str:
    text = re.sub(r"\s+", " ", value or "").strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def english_word_count(value: str) -> int:
    return len(re.findall(r"[A-Za-z0-9]+(?:[-'’][A-Za-z0-9]+)*", value or ""))


def is_long_tweet(tweet: dict[str, Any]) -> bool:
    return int(tweet.get("wordCount") or english_word_count(str(tweet.get("text") or ""))) > LONG_TWEET_WORD_THRESHOLD


async def fetch_public_account(
    value: str,
    count: int,
    stop_ids: set[str] | None = None,
    since_timestamp: int | None = None,
    cookie_file: Path | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    screen_name = normalize_screen_name(value)
    cookies = authenticated_cookie_map(cookie_file)
    if cookies:
        client = CompatibleAuthenticatedClient(language="en-US", timeout=25, user_agent=USER_AGENT)
        client.set_cookies(cookies, clear_cookies=True)
    else:
        client = CompatibleGuestClient(language="en-US", timeout=25)
    try:
        if not cookies:
            await client.activate()
        user = await client.get_user_by_screen_name(screen_name)
        tweets = await client.get_user_tweets(user.id, "Tweets", count=max(1, min(count, 20)))
        account = {
            "userId": str(user.id),
            "sourceId": f"TW_USER_{user.id}",
            "screenName": user.screen_name,
            "name": user.name or f"@{user.screen_name}",
            "description": user.description or "",
            "followersCount": user.followers_count or 0,
            "url": f"https://x.com/{user.screen_name}",
        }
        items: list[dict[str, Any]] = []
        seen: set[str] = set()
        hit_existing = False
        for page in range(MAX_TIMELINE_PAGES):
            page_last_timestamp = 0
            for tweet in tweets:
                tweet_id = str(tweet.id)
                if stop_ids and tweet_id in stop_ids:
                    hit_existing = True
                if not tweet_id.isdigit() or tweet_id in seen:
                    continue
                seen.add(tweet_id)
                full_text = str(tweet.full_text or "").strip()
                if not full_text:
                    continue
                published_at = parse_created_at(str(tweet.created_at or ""), tweet_id)
                page_last_timestamp = published_at or page_last_timestamp
                items.append({
                    "t": published_at,
                    "title": compact_text(full_text),
                    "text": full_text,
                    "wordCount": english_word_count(full_text),
                    "language": str(getattr(tweet, "lang", "") or ""),
                    "url": f"https://x.com/{user.screen_name}/status/{tweet_id}",
                    "rid": f"TW_TWEET_{tweet_id}",
                    "tweetId": tweet_id,
                    "createdAt": str(tweet.created_at or ""),
                    "replyCount": int(tweet.reply_count or 0),
                    "retweetCount": int(tweet.retweet_count or 0),
                    "favoriteCount": int(tweet.favorite_count or 0),
                })
            covered_window = since_timestamp is not None and page_last_timestamp > 0 and page_last_timestamp <= since_timestamp
            reached_safety_limit = len(items) >= MAX_TIMELINE_ITEMS
            if covered_window or reached_safety_limit or page == MAX_TIMELINE_PAGES - 1:
                break
            if since_timestamp is None and (len(items) >= count or hit_existing):
                break
            try:
                await asyncio.sleep(0.75)
                tweets = await tweets.next()
            except Exception:
                break
            if not tweets:
                break
        ordered = sorted(items, key=lambda item: (item["t"], item["tweetId"]), reverse=True)
        if since_timestamp is not None:
            ordered = [item for item in ordered if item["t"] >= since_timestamp]
        return account, ordered[:MAX_TIMELINE_ITEMS]
    finally:
        await client.http.aclose()


def fetch_public_account_with_retry(
    value: str,
    count: int,
    stop_ids: set[str] | None = None,
    attempts: int = 3,
    since_timestamp: int | None = None,
    cookie_file: Path | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            return asyncio.run(fetch_public_account(value, count, stop_ids, since_timestamp, cookie_file))
        except Exception as error:
            last_error = error
            if attempt < attempts - 1:
                time.sleep(2 ** attempt)
    raise last_error or RuntimeError("Twitter 请求失败")


def resolve(value: str, count: int = 5, cookie_file: Path | None = None) -> dict[str, Any]:
    account, tweets = fetch_public_account_with_retry(value, count, cookie_file=cookie_file)
    return {**account, "sample": tweets[:count]}


def subscribe(data_root: Path, value: str, initial_limit: int) -> dict[str, Any]:
    files = paths(data_root)
    account, _ = fetch_public_account_with_retry(value, 1, cookie_file=files["cookies"])
    config = read_json(files["subscriptions"], {"accounts": [], "settings": {}})
    accounts = config.setdefault("accounts", [])
    existing = next((item for item in accounts if item.get("userId") == account["userId"]), None)
    entry = {
        **account,
        "enabled": True,
        "initialTweetLimit": max(1, min(int(initial_limit), 20)),
        "addedAt": existing.get("addedAt") if existing else now_iso(),
        "feedTag": existing.get("feedTag") if existing and existing.get("feedTag") in {"高频", "低频"} else "低频",
        "mutedInFeed": existing.get("mutedInFeed") is True if existing else False,
        **({"lastSyncedAt": existing["lastSyncedAt"]} if existing and existing.get("lastSyncedAt") else {}),
    }
    if existing:
        accounts[accounts.index(existing)] = entry
    else:
        accounts.append(entry)
    settings = config.setdefault("settings", {})
    settings["maxTimelineItemsPerAccount"] = max(
        int(settings.get("maxTimelineItemsPerAccount") or 0), MAX_TIMELINE_ITEMS,
    )
    settings.setdefault("requestIntervalSeconds", 5)
    settings.setdefault("openRefreshCooldownMinutes", 30)
    settings.setdefault("scheduleLocalTimes", ["12:00", "20:00"])
    settings.setdefault("translationProvider", TERRA_PROVIDER)
    settings.setdefault("translationFallback", "google")
    settings.setdefault("highFrequencyWindowDays", HIGH_FREQUENCY_WINDOW_DAYS)
    settings.setdefault("lowFrequencyWindowDays", LOW_FREQUENCY_WINDOW_DAYS)
    config["updatedAt"] = now_iso()
    write_json(files["subscriptions"], config)
    return entry


def merge_source(library: dict[str, Any], account: dict[str, Any], tweets: list[dict[str, Any]]) -> None:
    sources = library.setdefault("sources", [])
    existing = next((source for source in sources if source.get("bookId") == account["sourceId"]), None)
    existing_items = (existing or {}).get("items", [])
    by_id = {item.get("rid"): item for item in existing_items if item.get("rid")}
    by_id.update({item["rid"]: item for item in tweets})
    source = {
        "name": account["name"],
        "bookId": account["sourceId"],
        "platform": "twitter",
        "screenName": account["screenName"],
        "profileUrl": account["url"],
        "items": sorted(by_id.values(), key=lambda item: item.get("t", 0), reverse=True),
    }
    if existing:
        sources[sources.index(existing)] = source
    else:
        sources.append(source)


def safe_name(value: str) -> str:
    clean = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "-", value or "")
    return re.sub(r"\s+", " ", clean).strip(" .-")[:100] or "tweet"


def translation_chunks(value: str, limit: int = 1200) -> list[str]:
    chunks: list[str] = []
    remaining = value.strip()
    while remaining:
        if len(remaining) <= limit:
            chunks.append(remaining)
            break
        cut = max(remaining.rfind("\n", 0, limit), remaining.rfind(". ", 0, limit), remaining.rfind(" ", 0, limit))
        if cut < limit // 2:
            cut = limit
        else:
            cut += 1
        chunks.append(remaining[:cut].strip())
        remaining = remaining[cut:].strip()
    return chunks


def translate_with_google(value: str) -> str:
    translated: list[str] = []
    for chunk in translation_chunks(value):
        query = urllib.parse.urlencode({
            "client": "gtx", "sl": "auto", "tl": "zh-CN", "dt": "t", "q": chunk,
        })
        request = urllib.request.Request(
            f"https://translate.googleapis.com/translate_a/single?{query}",
            headers={"User-Agent": "We-Read/1.0"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
        text = "".join(str(segment[0] or "") for segment in (payload[0] or []) if segment)
        if not text.strip():
            raise RuntimeError("翻译服务返回空结果")
        translated.append(text.strip())
    result = "\n\n".join(translated).strip()
    if not result:
        raise RuntimeError("没有可翻译的推文正文")
    return result


def codex_binary() -> str:
    binary = shutil.which("codex")
    if binary:
        return binary
    fallback = Path.home() / ".local" / "bin" / "codex"
    if fallback.is_file():
        return str(fallback)
    raise RuntimeError("找不到 Codex CLI，无法调用 Terra 翻译")


def codex_environment(binary: str) -> dict[str, str]:
    """Ensure an env-shebang Codex CLI can find Node under LaunchAgent."""
    environment = os.environ.copy()
    candidates = [str(Path(binary).resolve().parent), str(Path.home() / ".local" / "bin")]
    candidates.extend(part for part in environment.get("PATH", "").split(os.pathsep) if part)
    environment["PATH"] = os.pathsep.join(dict.fromkeys(candidates))
    return environment


def value_filter_prompt(tweets: list[dict[str, Any]]) -> str:
    payload = [{
        "id": item["rid"],
        "author": item.get("source") or item.get("account"),
        "publishedAt": item.get("createdAt"),
        "text": item.get("text") or item.get("title"),
        "url": item.get("url"),
    } for item in tweets]
    return """你是 We-Read 的 Twitter 投资研究信息筛选 Agent。逐条阅读输入，判断是否值得进入正式信息流。

KEEP：内容对公司、股票、产品、技术、产业或重大叙事提供了可独立理解的实质信息；至少包含一个有效信息单元，例如事实、数字、产品变化、比较、机制、因果、明确预测、可验证问题或可操作结论。没有数据的观点也可以保留，但必须给出可理解的分析框架。

DROP：纯感谢、祝贺、寒暄、情绪、玩笑、口号、无上下文链接、无法独立理解的短回复或同步提示、仅出现人名/公司/产品名、以及没有作者补充分析的 RT。诸如 “Grok @Bot” 或 “Sync to Origin” 这类只有动作或名词、没有事实与分析的内容必须 DROP。

规则：
1. `RT @...` 默认 DROP；若原文可能有价值，只在 caveat 说明，不得放行。
2. 正文被截断或关键上下文缺失时通常 DROP。
3. 出现公司、股票代码、产品或名人本身不构成价值，必须还有有效信息单元。
4. 不根据点赞量、转发量或作者名气判断。
5. 筛选“是否值得读”，不替推文的事实真实性背书。

reason 用简体中文给出一到两句具体理由；valueSignals 只列实际命中的信息单元；confidence 为 0 到 1。id 必须原样返回，输出符合 JSON Schema。

输入：
""" + json.dumps(payload, ensure_ascii=False)


def classify_value_with_terra(tweets: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    if not tweets:
        return {}
    output_path = ""
    try:
        with tempfile.NamedTemporaryFile(prefix="we-read-twitter-value-filter-", suffix=".json", delete=False) as output:
            output_path = output.name
        command = [
            codex_binary(), "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
            "--skip-git-repo-check", "--sandbox", "read-only", "-C", str(PROJECT),
            "-m", TERRA_MODEL, "-c", 'model_reasoning_effort="medium"', "--color", "never",
            "--output-schema", str(VALUE_FILTER_SCHEMA), "-o", output_path, "-",
        ]
        result = subprocess.run(
            command, input=value_filter_prompt(tweets), text=True, capture_output=True,
            timeout=300, check=False, env=codex_environment(command[0]),
        )
        if result.returncode != 0:
            raise RuntimeError((result.stderr or result.stdout or "Twitter 价值审核失败")[-1200:])
        parsed = json.loads(Path(output_path).read_text(encoding="utf-8"))
        decisions = {
            str(item.get("id")): item for item in parsed.get("decisions", [])
            if item.get("id") and item.get("decision") in {"keep", "drop"}
        }
        expected = {item["rid"] for item in tweets}
        if set(decisions) != expected:
            raise RuntimeError(f"Twitter 审核闸门结果不完整：期望 {len(expected)} 条，返回 {len(decisions)} 条")
        return decisions
    finally:
        if output_path:
            Path(output_path).unlink(missing_ok=True)


def classify_value_queue(tweets: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    decisions: dict[str, dict[str, Any]] = {}
    batch: list[dict[str, Any]] = []
    batch_chars = 0
    batches: list[list[dict[str, Any]]] = []
    for tweet in tweets:
        length = len(str(tweet.get("text") or ""))
        if batch and (len(batch) >= 20 or batch_chars + length > 24000):
            batches.append(batch)
            batch, batch_chars = [], 0
        batch.append(tweet)
        batch_chars += length
    if batch:
        batches.append(batch)
    for current in batches:
        # Deliberately no permissive fallback: an incomplete review stops the sync.
        decisions.update(classify_value_with_terra(current))
    return decisions


def apply_value_decision(tweet: dict[str, Any], decision: dict[str, Any]) -> None:
    tweet.update({
        "valueDecision": decision["decision"],
        "valueReason": str(decision.get("reason") or "").strip(),
        "valueSignals": [str(value) for value in decision.get("valueSignals", [])],
        "valueCaveat": str(decision.get("caveat") or "").strip(),
        "valueConfidence": float(decision.get("confidence") or 0),
        "valueFilterProvider": VALUE_FILTER_PROVIDER,
        "valueFilterVersion": VALUE_FILTER_VERSION,
        "valueReviewedAt": now_iso(),
    })


def translate_with_terra(tweets: list[dict[str, Any]]) -> dict[str, str]:
    if not tweets:
        return {}
    payload = [{"id": item["rid"], "text": item["text"]} for item in tweets]
    prompt = """你是 Twitter 推文翻译器。把输入 JSON 中每条 text 忠实翻译为自然、简洁的简体中文。
完整保留 @账号、URL、话题标签、数字、产品名、人名、技术名词和署名，不添加解释或原文没有的信息；
尽量保留原文语气、修辞、短句节奏及不确定性，避免生硬直译。输出必须符合给定 JSON Schema，id 原样返回。

输入：
""" + json.dumps(payload, ensure_ascii=False)
    output_path = ""
    try:
        with tempfile.NamedTemporaryFile(prefix="we-read-twitter-translation-", suffix=".json", delete=False) as output:
            output_path = output.name
        command = [
            codex_binary(), "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
            "--skip-git-repo-check", "--sandbox", "read-only", "-C", str(PROJECT),
            "-m", TERRA_MODEL, "-c", 'model_reasoning_effort="low"', "--color", "never",
            "--output-schema", str(TRANSLATION_SCHEMA), "-o", output_path, "-",
        ]
        result = subprocess.run(
            command,
            input=prompt,
            text=True,
            capture_output=True,
            timeout=240,
            check=False,
            env=codex_environment(command[0]),
        )
        if result.returncode != 0:
            raise RuntimeError((result.stderr or result.stdout or "Terra 翻译失败")[-1200:])
        parsed = json.loads(Path(output_path).read_text(encoding="utf-8"))
        translations = {
            str(item.get("id")): str(item.get("translation") or "").strip()
            for item in parsed.get("translations", []) if item.get("id") and item.get("translation")
        }
        missing = [item["rid"] for item in tweets if not translations.get(item["rid"])]
        if missing:
            raise RuntimeError(f"Terra 未返回 {len(missing)} 条翻译")
        return translations
    finally:
        if output_path:
            Path(output_path).unlink(missing_ok=True)


def translate_queue(tweets: list[dict[str, Any]]) -> tuple[dict[str, str], dict[str, str]]:
    translations: dict[str, str] = {}
    providers: dict[str, str] = {}
    batch: list[dict[str, Any]] = []
    batch_chars = 0
    batches: list[list[dict[str, Any]]] = []
    for tweet in tweets:
        length = len(tweet.get("text", ""))
        if batch and (len(batch) >= 12 or batch_chars + length > 18000):
            batches.append(batch)
            batch, batch_chars = [], 0
        batch.append(tweet)
        batch_chars += length
    if batch:
        batches.append(batch)
    for current in batches:
        try:
            result = translate_with_terra(current)
            for tweet in current:
                translations[tweet["rid"]] = result[tweet["rid"]]
                providers[tweet["rid"]] = TERRA_PROVIDER
        except Exception as error:
            print(f"Terra 批量翻译失败，改用 Google 回退：{error}", file=sys.stderr)
            for tweet in current:
                translations[tweet["rid"]] = translate_with_google(tweet["text"])
                providers[tweet["rid"]] = "google-fallback"
    return translations, providers


def generate_presentations_with_terra(tweets: list[dict[str, Any]]) -> dict[str, dict[str, str]]:
    if not tweets:
        return {}
    payload = [{
        "id": item["rid"],
        "translation": item["translation"],
        "wordCount": int(item.get("wordCount") or english_word_count(item.get("text", ""))),
    } for item in tweets]
    prompt = """你是 Twitter 长文的信息架构编辑。输入是已经忠实翻译成中文、且英文原文超过 500 词的长推文。
为每条生成：
1. displayTitle：准确、克制的简体中文标题，尽量不超过 35 个汉字；
2. abstract：120-220 个汉字的中文摘要，覆盖核心主张、关键依据与结论。
必须保留重要人名、产品名、技术词、数字和不确定性；不要评价、拔高、补充背景或添加原文没有的信息。
id 必须原样返回，输出必须符合给定 JSON Schema。

输入：
""" + json.dumps(payload, ensure_ascii=False)
    output_path = ""
    try:
        with tempfile.NamedTemporaryFile(prefix="we-read-twitter-presentation-", suffix=".json", delete=False) as output:
            output_path = output.name
        command = [
            codex_binary(), "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
            "--skip-git-repo-check", "--sandbox", "read-only", "-C", str(PROJECT),
            "-m", TERRA_MODEL, "-c", 'model_reasoning_effort="low"', "--color", "never",
            "--output-schema", str(PRESENTATION_SCHEMA), "-o", output_path, "-",
        ]
        result = subprocess.run(
            command, input=prompt, text=True, capture_output=True, timeout=240, check=False,
            env=codex_environment(command[0]),
        )
        if result.returncode != 0:
            raise RuntimeError((result.stderr or result.stdout or "长推文标题摘要生成失败")[-1200:])
        parsed = json.loads(Path(output_path).read_text(encoding="utf-8"))
        presentations = {
            str(item.get("id")): {
                "displayTitle": str(item.get("displayTitle") or "").strip(),
                "abstract": str(item.get("abstract") or "").strip(),
            }
            for item in parsed.get("presentations", []) if item.get("id")
        }
        missing = [item["rid"] for item in tweets if not presentations.get(item["rid"], {}).get("displayTitle") or not presentations.get(item["rid"], {}).get("abstract")]
        if missing:
            raise RuntimeError(f"Terra 未返回 {len(missing)} 条完整标题摘要")
        return presentations
    finally:
        if output_path:
            Path(output_path).unlink(missing_ok=True)


def presentation_queue(tweets: list[dict[str, Any]]) -> dict[str, dict[str, str]]:
    presentations: dict[str, dict[str, str]] = {}
    batches: list[list[dict[str, Any]]] = []
    batch: list[dict[str, Any]] = []
    batch_chars = 0
    for tweet in tweets:
        length = len(tweet.get("translation", ""))
        if batch and (len(batch) >= 4 or batch_chars + length > 28000):
            batches.append(batch)
            batch, batch_chars = [], 0
        batch.append(tweet)
        batch_chars += length
    if batch:
        batches.append(batch)
    for current in batches:
        try:
            presentations.update(generate_presentations_with_terra(current))
        except Exception as error:
            print(f"长推文标题摘要生成失败，将暂时显示完整中文译文：{error}", file=sys.stderr)
    return presentations


def archive_tweet(data_root: Path, account: dict[str, Any], tweet: dict[str, Any]) -> dict[str, Any]:
    translation = str(tweet.get("translation") or "").strip()
    if not translation:
        raise RuntimeError("推文尚未完成中文翻译")
    word_count = int(tweet.get("wordCount") or english_word_count(tweet.get("text", "")))
    tweet["wordCount"] = word_count
    display_title = str(tweet.get("displayTitle") or "").strip()
    abstract = str(tweet.get("abstract") or "").strip()
    has_long_presentation = word_count > LONG_TWEET_WORD_THRESHOLD and bool(display_title and abstract)
    day = dt.datetime.fromtimestamp(tweet["t"], dt.timezone.utc).date().isoformat() if tweet["t"] else "unknown-date"
    folder = f"{day} {tweet['tweetId']}"
    target = data_root / "文章" / "Twitter" / safe_name(account["screenName"]) / folder / f"{folder}.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    markdown = "\n".join([
        "---",
        f"title: {json.dumps(tweet['title'], ensure_ascii=False)}",
        "platform: twitter",
        f"account: {json.dumps(account['name'], ensure_ascii=False)}",
        f"screen_name: {json.dumps(account['screenName'], ensure_ascii=False)}",
        f"tweet_id: {json.dumps(tweet['tweetId'])}",
        f"source: {json.dumps(tweet['url'])}",
        f"published_at: {json.dumps(tweet.get('createdAt', ''))}",
        f"language: {json.dumps(tweet.get('language', ''))}",
        f"word_count: {word_count}",
        f"translation_provider: {json.dumps(tweet.get('translationProvider', ''))}",
        f"presentation_provider: {json.dumps(tweet.get('presentationProvider', ''))}",
        f"value_decision: {json.dumps(tweet.get('valueDecision', ''))}",
        f"value_filter_provider: {json.dumps(tweet.get('valueFilterProvider', ''))}",
        f"value_filter_version: {int(tweet.get('valueFilterVersion') or 0)}",
        f"value_reason: {json.dumps(tweet.get('valueReason', ''), ensure_ascii=False)}",
        f"display_title: {json.dumps(display_title, ensure_ascii=False)}",
        f"captured_at: {json.dumps(now_iso())}",
        "---", "",
        f"# {display_title if has_long_presentation else tweet['title']}", "",
        *(["## 中文摘要", "", abstract, ""] if has_long_presentation else []),
        "## 中文翻译", "",
        translation, "",
        "## 英文原文", "",
        tweet["text"], "",
        f"> [在 X 上查看原帖]({tweet['url']}) · {tweet['replyCount']} 回复 · {tweet['retweetCount']} 转发 · {tweet['favoriteCount']} 喜欢", "",
    ])
    target.write_text(markdown, encoding="utf-8")
    return {
        "sourceId": account["sourceId"], "account": account["name"], "title": display_title if has_long_presentation else tweet["title"],
        "url": tweet["url"], "markdown": str(target.relative_to(data_root)), "archivedAt": now_iso(),
        "translatedAt": now_iso(), **({"presentedAt": now_iso()} if has_long_presentation else {}),
    }


def update_library_item(library: dict[str, Any], source_id: str, tweet: dict[str, Any]) -> None:
    source = next((item for item in library.get("sources", []) if item.get("bookId") == source_id), None)
    if not source:
        return
    existing = next((item for item in source.get("items", []) if item.get("rid") == tweet["rid"]), None)
    if existing:
        existing.update(tweet)


def emit_progress(completed: int, total: int, archived: int, failed: int) -> None:
    print("WE_READ_TWITTER_PROGRESS " + json.dumps({
        "completed": completed, "total": total, "archived": archived, "failed": failed,
    }), file=sys.stderr, flush=True)


def sync(data_root: Path, source_id: str | None, max_new: int, delay: float) -> dict[str, Any]:
    files = paths(data_root)
    config = read_json(files["subscriptions"], {"accounts": [], "settings": {}})
    library = read_json(files["library"], {"updatedAt": None, "sources": []})
    status = read_json(files["status"], {"archived": {}, "failures": {}, "deleted": {}})
    deleted_ids = set(status.get("deleted", {}))
    filtered_ids = set(status.get("filtered", {}))
    settings = config.setdefault("settings", {})
    settings["maxTimelineItemsPerAccount"] = max(
        int(settings.get("maxTimelineItemsPerAccount") or 0), MAX_TIMELINE_ITEMS,
    )
    accounts = [item for item in config.get("accounts", []) if item.get("enabled", True)]
    if source_id:
        accounts = [item for item in accounts if item.get("sourceId") == source_id]
    queue: list[tuple[dict[str, Any], dict[str, Any]]] = []
    errors = []
    for index, stored in enumerate(accounts):
        try:
            feed_tag = stored.get("feedTag") if stored.get("feedTag") in {"高频", "低频"} else "低频"
            window_setting = "highFrequencyWindowDays" if feed_tag == "高频" else "lowFrequencyWindowDays"
            default_window = HIGH_FREQUENCY_WINDOW_DAYS if feed_tag == "高频" else LOW_FREQUENCY_WINDOW_DAYS
            sync_window_days = max(1, min(int(settings.get(window_setting) or default_window), 90))
            since_timestamp = int(time.time()) - sync_window_days * 24 * 60 * 60
            existing_source = next((s for s in library.get("sources", []) if s.get("bookId") == stored["sourceId"]), None)
            existing_items = {item.get("rid"): item for item in (existing_source or {}).get("items", []) if item.get("rid")}
            existing_ids = set(existing_items)
            known_tweet_ids = {rid.removeprefix("TW_TWEET_") for rid in existing_ids}
            fetch_limit = min(int(settings.get("maxTimelineItemsPerAccount") or MAX_TIMELINE_ITEMS), MAX_TIMELINE_ITEMS)
            fetched, discovered = fetch_public_account_with_retry(
                stored["screenName"], fetch_limit, known_tweet_ids,
                since_timestamp=since_timestamp, cookie_file=files["cookies"],
            )
            discovered = [
                item for item in discovered
                if item["rid"] not in deleted_ids and item["rid"] not in filtered_ids
            ]
            stored.update({key: fetched[key] for key in ("screenName", "name", "description", "followersCount", "url")})
            limit = max_new
            selected = [item for item in discovered if item["rid"] not in existing_ids][:limit]
            if not existing_ids:
                selected = discovered[:limit]
            candidates = list(selected)
            for item in discovered:
                archived_entry = status.get("archived", {}).get(item["rid"], {})
                existing_item = existing_items.get(item["rid"], {})
                existing_item["wordCount"] = int(existing_item.get("wordCount") or english_word_count(existing_item.get("text", "")))
                if item["rid"] in existing_ids and (
                    not existing_item.get("translation")
                    or not archived_entry.get("translatedAt")
                    or existing_item.get("translationProvider") != TERRA_PROVIDER
                    or (is_long_tweet(existing_item) and (not existing_item.get("displayTitle") or not existing_item.get("abstract")))
                ):
                    candidates.append(item)
            queued_ids: set[str] = set()
            for item in candidates:
                if item["rid"] not in queued_ids and item["rid"] not in deleted_ids and item["rid"] not in filtered_ids:
                    queue.append((stored, item))
                    queued_ids.add(item["rid"])
            stored["lastSyncedAt"] = now_iso()
        except Exception as error:
            errors.append({"sourceId": stored.get("sourceId"), "error": f"{error.__class__.__name__}: {error}"})
        if delay > 0 and index < len(accounts) - 1:
            time.sleep(delay)
    decisions = classify_value_queue([tweet for _, tweet in queue])
    kept_queue: list[tuple[dict[str, Any], dict[str, Any]]] = []
    filtered = 0
    for account, tweet in queue:
        decision = decisions[tweet["rid"]]
        apply_value_decision(tweet, decision)
        if decision["decision"] == "keep":
            kept_queue.append((account, tweet))
            continue
        filtered += 1
        status.setdefault("filtered", {})[tweet["rid"]] = {
            "sourceId": account["sourceId"], "account": account["name"],
            "title": tweet["title"], "url": tweet["url"],
            "reason": tweet["valueReason"], "valueSignals": tweet["valueSignals"],
            "caveat": tweet["valueCaveat"], "confidence": tweet["valueConfidence"],
            "provider": VALUE_FILTER_PROVIDER, "version": VALUE_FILTER_VERSION,
            "reviewedAt": tweet["valueReviewedAt"],
        }
        existing_source = next((source for source in library.get("sources", []) if source.get("bookId") == account["sourceId"]), None)
        if existing_source:
            existing_source["items"] = [item for item in existing_source.get("items", []) if item.get("rid") != tweet["rid"]]
    queue = kept_queue
    library["updatedAt"] = now_iso()
    config["updatedAt"] = now_iso()
    status["updatedAt"] = now_iso()
    write_json(files["library"], library)
    write_json(files["subscriptions"], config)
    write_json(files["status"], status)
    completed = archived = failed = 0
    emit_progress(0, len(queue), 0, 0)
    translations, translation_providers = translate_queue([tweet for _, tweet in queue])
    for _, tweet in queue:
        tweet["translation"] = translations[tweet["rid"]]
        tweet["translationProvider"] = translation_providers[tweet["rid"]]
        tweet["wordCount"] = int(tweet.get("wordCount") or english_word_count(tweet.get("text", "")))
    presentation_candidates = [
        tweet for _, tweet in queue
        if is_long_tweet(tweet) and (not tweet.get("displayTitle") or not tweet.get("abstract"))
    ]
    presentations = presentation_queue(presentation_candidates)
    for tweet in presentation_candidates:
        presentation = presentations.get(tweet["rid"])
        if presentation:
            tweet.update(presentation)
            tweet["presentationProvider"] = PRESENTATION_PROVIDER
    for account, tweet in queue:
        merge_source(library, account, [tweet])
    for account, tweet in queue:
        try:
            status.setdefault("archived", {})[tweet["rid"]] = archive_tweet(data_root, account, tweet)
            status.setdefault("failures", {}).pop(tweet["rid"], None)
            update_library_item(library, account["sourceId"], tweet)
            library["updatedAt"] = now_iso()
            write_json(files["library"], library)
            archived += 1
        except Exception as error:
            status.setdefault("failures", {})[tweet["rid"]] = {
                "sourceId": account["sourceId"], "title": tweet["title"], "url": tweet["url"],
                "error": f"{error.__class__.__name__}: {error}", "attemptedAt": now_iso(),
            }
            failed += 1
        completed += 1
        status["updatedAt"] = now_iso()
        write_json(files["status"], status)
        emit_progress(completed, len(queue), archived, failed)
    return {"accounts": len(accounts), "reviewed": len(decisions), "filtered": filtered, "queued": len(queue), "archived": archived, "failed": failed, "errors": errors}


def backfill_presentations(data_root: Path) -> dict[str, int]:
    files = paths(data_root)
    library = read_json(files["library"], {"updatedAt": None, "sources": []})
    status = read_json(files["status"], {"archived": {}, "failures": {}, "deleted": {}})
    candidates: list[tuple[dict[str, Any], dict[str, Any]]] = []
    scanned = 0
    for source in library.get("sources", []):
        if source.get("platform") != "twitter":
            continue
        account = {
            "sourceId": source["bookId"], "name": source["name"],
            "screenName": source.get("screenName") or source["name"],
        }
        for tweet in source.get("items", []):
            scanned += 1
            tweet["wordCount"] = int(tweet.get("wordCount") or english_word_count(tweet.get("text", "")))
            if is_long_tweet(tweet) and tweet.get("translation") and (not tweet.get("displayTitle") or not tweet.get("abstract")):
                candidates.append((account, tweet))
    presentations = presentation_queue([tweet for _, tweet in candidates])
    generated = 0
    for account, tweet in candidates:
        presentation = presentations.get(tweet["rid"])
        if not presentation:
            continue
        tweet.update(presentation)
        tweet["presentationProvider"] = PRESENTATION_PROVIDER
        status.setdefault("archived", {})[tweet["rid"]] = archive_tweet(data_root, account, tweet)
        status.setdefault("failures", {}).pop(tweet["rid"], None)
        generated += 1
    library["updatedAt"] = now_iso()
    status["updatedAt"] = now_iso()
    write_json(files["library"], library)
    write_json(files["status"], status)
    return {"scanned": scanned, "eligible": len(candidates), "generated": generated}


def backfill_value_gate(data_root: Path, account_filter: str | None = None, limit: int = 0) -> dict[str, int]:
    """Audit legacy library items. Dropped Markdown is retained as recoverable quarantine."""
    files = paths(data_root)
    library = read_json(files["library"], {"updatedAt": None, "sources": []})
    status = read_json(files["status"], {"archived": {}, "failures": {}, "deleted": {}, "filtered": {}})
    needle = (account_filter or "").strip().lstrip("@").casefold()
    candidates: list[tuple[dict[str, Any], dict[str, Any]]] = []
    scanned = 0
    for source in library.get("sources", []):
        if source.get("platform") != "twitter":
            continue
        if needle and needle not in {
            str(source.get("screenName") or "").casefold(),
            str(source.get("bookId") or "").casefold(),
        }:
            continue
        account = {
            "sourceId": source["bookId"], "name": source["name"],
            "screenName": source.get("screenName") or source["name"],
        }
        for tweet in source.get("items", []):
            scanned += 1
            if int(tweet.get("valueFilterVersion") or 0) < VALUE_FILTER_VERSION:
                candidates.append((account, tweet))
    candidates.sort(key=lambda pair: (int(pair[1].get("t") or 0), str(pair[1].get("rid") or "")), reverse=True)
    if limit > 0:
        candidates = candidates[:limit]
    decisions = classify_value_queue([tweet for _, tweet in candidates])
    kept = filtered = 0
    dropped_ids: set[str] = set()
    for account, tweet in candidates:
        decision = decisions[tweet["rid"]]
        apply_value_decision(tweet, decision)
        if decision["decision"] == "keep":
            kept += 1
            continue
        filtered += 1
        dropped_ids.add(tweet["rid"])
        previous_archive = status.setdefault("archived", {}).pop(tweet["rid"], None)
        status.setdefault("failures", {}).pop(tweet["rid"], None)
        status.setdefault("filtered", {})[tweet["rid"]] = {
            "sourceId": account["sourceId"], "account": account["name"],
            "title": tweet.get("title"), "url": tweet.get("url"),
            "reason": tweet["valueReason"], "valueSignals": tweet["valueSignals"],
            "caveat": tweet["valueCaveat"], "confidence": tweet["valueConfidence"],
            "provider": VALUE_FILTER_PROVIDER, "version": VALUE_FILTER_VERSION,
            "reviewedAt": tweet["valueReviewedAt"],
            **({"quarantinedArchive": previous_archive} if previous_archive else {}),
        }
    if dropped_ids:
        for source in library.get("sources", []):
            if source.get("platform") == "twitter":
                source["items"] = [item for item in source.get("items", []) if item.get("rid") not in dropped_ids]
    library["updatedAt"] = now_iso()
    status["updatedAt"] = now_iso()
    write_json(files["library"], library)
    write_json(files["status"], status)
    remaining = sum(
        1 for source in library.get("sources", []) if source.get("platform") == "twitter"
        for tweet in source.get("items", []) if int(tweet.get("valueFilterVersion") or 0) < VALUE_FILTER_VERSION
    )
    return {"scanned": scanned, "reviewed": len(candidates), "kept": kept, "filtered": filtered, "remaining": remaining}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Twitter/X integration for We-Read")
    parser.add_argument("--data-root", default=str(DEFAULT_DATA))
    commands = parser.add_subparsers(dest="command", required=True)
    resolve_cmd = commands.add_parser("resolve")
    resolve_cmd.add_argument("account")
    resolve_cmd.add_argument("--count", type=int, default=5)
    add = commands.add_parser("subscribe")
    add.add_argument("account")
    add.add_argument("--initial-limit", type=int, default=10)
    run = commands.add_parser("sync")
    run.add_argument("--source-id")
    run.add_argument("--max-new", type=int, default=20)
    run.add_argument("--delay", type=float, default=5)
    commands.add_parser("backfill-presentations")
    value_gate = commands.add_parser("backfill-value-gate")
    value_gate.add_argument("--account")
    value_gate.add_argument("--limit", type=int, default=0)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    data_root = Path(args.data_root).expanduser().resolve()
    if args.command in {"resolve", "subscribe", "sync"}:
        refresh_browser_cookies(data_root)
    if args.command == "resolve":
        result = resolve(args.account, max(1, min(args.count, 20)), paths(data_root)["cookies"])
    elif args.command == "subscribe":
        result = subscribe(data_root, args.account, args.initial_limit)
    elif args.command == "sync":
        result = sync(data_root, args.source_id, max(1, min(args.max_new, MAX_TIMELINE_ITEMS)), max(0, args.delay))
    elif args.command == "backfill-presentations":
        result = backfill_presentations(data_root)
    else:
        result = backfill_value_gate(data_root, args.account, max(0, args.limit))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
