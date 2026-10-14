#!/usr/bin/env python3
"""Low-volume YouTube channel discovery and transcript archiving for We-Read."""

from __future__ import annotations

import argparse
import datetime as dt
import html
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
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

import yt_dlp
from youtube_transcript_api import YouTubeTranscriptApi


PROJECT = Path(__file__).resolve().parent.parent
DEFAULT_DATA = PROJECT / "data"
PREFERRED_LANGUAGES = [
    "en", "en-US", "en-GB", "zh-Hans", "zh-Hant", "zh-CN", "zh-TW", "zh"
]
VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
CHANNEL_ID = re.compile(r"^UC[A-Za-z0-9_-]{20,30}$")
YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}
TERRA_MODEL = "gpt-5.6-terra"
MANUSCRIPT_PROVIDER = "codex:gpt-5.6-terra:medium:lossless-v1"
SUMMARY_PROVIDER = "codex:gpt-5.6-terra:high"
MANUSCRIPT_SCHEMA = Path(__file__).with_name("manuscript.schema.json")
SUMMARY_SCHEMA = Path(__file__).with_name("summary.schema.json")


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def safe_name(value: str, fallback: str = "untitled") -> str:
    clean = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "-", html.unescape(value or ""))
    clean = re.sub(r"\s+", " ", clean).strip(" .-")
    return (clean[:120] or fallback)


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


def validate_youtube_url(value: str) -> str:
    value = value.strip()
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in YOUTUBE_HOSTS:
        raise ValueError("请输入 youtube.com 的频道链接")
    return value


def videos_endpoint(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    if parsed.hostname == "youtu.be" or parsed.path == "/watch":
        return url
    path = parsed.path.rstrip("/")
    if not path.endswith("/videos"):
        path += "/videos"
    return urllib.parse.urlunparse(parsed._replace(path=path, query="", fragment=""))


def resolve_channel(url: str) -> dict[str, str]:
    url = validate_youtube_url(url)
    options = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
        "playlistend": 1,
        "skip_download": True,
    }
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(videos_endpoint(url), download=False)
    channel_id = str(info.get("channel_id") or info.get("uploader_id") or "")
    if not CHANNEL_ID.fullmatch(channel_id):
        raise RuntimeError("未能解析 YouTube channel_id，请粘贴频道主页或 /videos 链接")
    name = str(info.get("channel") or info.get("uploader") or info.get("title") or channel_id)
    canonical = str(info.get("channel_url") or f"https://www.youtube.com/channel/{channel_id}")
    return {
        "channelId": channel_id,
        "sourceId": f"YT_CHANNEL_{channel_id}",
        "name": name.removesuffix(" - Videos"),
        "url": canonical,
    }


def parse_timestamp(value: str) -> int:
    if not value:
        return 0
    try:
        return int(dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return 0


def discover_rss(channel: dict[str, str]) -> list[dict[str, Any]]:
    feed_url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel['channelId']}"
    request = urllib.request.Request(feed_url, headers={"User-Agent": "We-Read/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        root = ET.fromstring(response.read())
    ns = {
        "atom": "http://www.w3.org/2005/Atom",
        "yt": "http://www.youtube.com/xml/schemas/2015",
        "media": "http://search.yahoo.com/mrss/",
    }
    videos = []
    for entry in root.findall("atom:entry", ns):
        video_id = (entry.findtext("yt:videoId", default="", namespaces=ns) or "").strip()
        if not VIDEO_ID.fullmatch(video_id):
            continue
        title = (entry.findtext("atom:title", default=video_id, namespaces=ns) or video_id).strip()
        published = entry.findtext("atom:published", default="", namespaces=ns) or ""
        description = entry.findtext("media:group/media:description", default="", namespaces=ns) or ""
        videos.append({
            "t": parse_timestamp(published),
            "title": title,
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "rid": f"YT_VIDEO_{video_id}",
            "videoId": video_id,
            "publishedAt": published,
            "description": description[:1000],
        })
    return sorted(videos, key=lambda item: item["t"], reverse=True)


def discover_ytdlp(channel: dict[str, str], count: int = 15) -> list[dict[str, Any]]:
    options = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": True,
        "playlistend": count,
        "skip_download": True,
    }
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(videos_endpoint(channel["url"]), download=False)
    videos = []
    for entry in info.get("entries") or []:
        if not isinstance(entry, dict):
            continue
        video_id = str(entry.get("id") or "")
        if not VIDEO_ID.fullmatch(video_id):
            continue
        upload_date = str(entry.get("upload_date") or "")
        published = f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:8]}T00:00:00Z" if len(upload_date) == 8 else ""
        videos.append({
            "t": parse_timestamp(published),
            "title": str(entry.get("title") or video_id),
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "rid": f"YT_VIDEO_{video_id}",
            "videoId": video_id,
            "publishedAt": published,
            "description": str(entry.get("description") or "")[:1000],
        })
    return videos


def discover(channel: dict[str, str]) -> list[dict[str, Any]]:
    try:
        videos = discover_rss(channel)
        if videos:
            return videos
    except Exception as error:
        print(f"RSS 发现失败，改用 yt-dlp：{error}", file=sys.stderr)
        return discover_ytdlp(channel)


def hydrate_video_metadata(video: dict[str, Any]) -> dict[str, Any]:
    """Fetch one watch page for fields missing from flat channel discovery."""
    options = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
    }
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(video["url"], download=False)
    timestamp = info.get("timestamp") or info.get("release_timestamp")
    published = ""
    if isinstance(timestamp, (int, float)) and timestamp > 0:
        published = dt.datetime.fromtimestamp(timestamp, dt.timezone.utc).isoformat().replace("+00:00", "Z")
    else:
        upload_date = str(info.get("upload_date") or "")
        if len(upload_date) == 8:
            published = f"{upload_date[:4]}-{upload_date[4:6]}-{upload_date[6:8]}T00:00:00Z"
    video.update({
        "t": parse_timestamp(published) or int(video.get("t") or 0),
        "publishedAt": published or str(video.get("publishedAt") or ""),
        "title": str(info.get("title") or video.get("title") or video["videoId"]),
        "description": str(info.get("description") or video.get("description") or "")[:1000],
    })
    return video


def yaml_string(value: str) -> str:
    return json.dumps(str(value or ""), ensure_ascii=False)


def time_label(seconds: float) -> str:
    value = max(0, int(seconds))
    hours, rest = divmod(value, 3600)
    minutes, seconds = divmod(rest, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes:02d}:{seconds:02d}"


def readable_paragraphs(value: str, limit: int) -> list[str]:
    """Turn transcript prose into readable paragraphs without changing its words."""
    value = html.unescape(str(value or "")).replace("\r", "")
    turns = re.split(r"\s*(?:>>|＞＞)\s*|\n{2,}", value)
    paragraphs: list[str] = []
    for turn in turns:
        turn = re.sub(r"[ \t\n]+", " ", turn).strip()
        while turn:
            if len(turn) <= limit:
                paragraphs.append(turn)
                break
            window = turn[:limit + 1]
            boundaries = [
                window.rfind(mark) + len(mark)
                for mark in ("。", "！", "？", ". ", "! ", "? ", "; ", "；")
                if window.rfind(mark) >= max(0, limit // 2)
            ]
            cut = max(boundaries, default=-1)
            if cut < 0:
                space = window.rfind(" ")
                cut = space if space >= limit // 2 else limit
            paragraphs.append(turn[:cut].strip())
            turn = turn[cut:].strip()
    return [paragraph for paragraph in paragraphs if paragraph]


def append_readable_segment(lines: list[str], video_url: str, start: int, value: str, limit: int) -> None:
    paragraphs = readable_paragraphs(value, limit)
    for index, paragraph in enumerate(paragraphs):
        prefix = f"[{time_label(start)}]({video_url}&t={start}s) " if index == 0 else ""
        lines.extend([prefix + paragraph, ""])


def select_transcript(api: YouTubeTranscriptApi, video_id: str):
    transcripts = api.list(video_id)
    for finder in (
        transcripts.find_manually_created_transcript,
        transcripts.find_generated_transcript,
        transcripts.find_transcript,
    ):
        try:
            return finder(PREFERRED_LANGUAGES)
        except Exception as error:
            if error.__class__.__name__ != "NoTranscriptFound":
                raise
    available = list(transcripts)
    if not available:
        raise RuntimeError("没有可用字幕")
    return available[0]


def codex_binary() -> str:
    binary = shutil.which("codex")
    if binary:
        return binary
    fallback = Path.home() / ".local" / "bin" / "codex"
    if fallback.is_file():
        return str(fallback)
    raise RuntimeError("找不到 Codex CLI，无法调用 Terra 翻译")


def codex_environment(binary: str) -> dict[str, str]:
    environment = os.environ.copy()
    candidates = [str(Path(binary).resolve().parent), str(Path.home() / ".local" / "bin")]
    candidates.extend(part for part in environment.get("PATH", "").split(os.pathsep) if part)
    environment["PATH"] = os.pathsep.join(dict.fromkeys(candidates))
    return environment


def manuscript_with_terra(title: str, segments: list[dict[str, Any]]) -> dict[str, Any]:
    payload = [{
        "id": segment["id"], "startSeconds": int(segment["start"]), "text": segment["text"],
    } for segment in segments]
    prompt = """你是长视频逐字稿编辑与翻译者。请先完整阅读所有英文字幕片段，再生成一份通顺、忠实、可连续阅读的中文逐字文稿。

这不是摘要。规则：
1. 不遗漏任何有意义的信息，包括事实、数字、例子、问题、回答、限定条件、转折、论证顺序和结论；
2. 利用全文上下文修复字幕的错误断句、重复碎片、口误式重复和明显 ASR 识别错误，但不得添加原文没有的信息；
3. 删除纯粹无语义的 um/uh、机械重复和 [music] 等噪声；有表达意义的语气、犹豫与强调必须保留；
4. 逐句忠实翻译成自然中文，保留人名、公司、产品、股票代码、技术词和数字；不要概括或压缩；
5. 按主题、说话人转换和自然语义合理分段，每段通常 3-7 句；
6. 每个输入 id 必须且只能出现在某一个 paragraph.sourceIds 中，sourceIds 必须保持输入顺序。这样可以审计是否遗漏。
7. titleZh 是忠实自然的中文标题。

输入：
""" + json.dumps({"title": title, "segments": payload}, ensure_ascii=False)
    output_path = ""
    try:
        with tempfile.NamedTemporaryFile(prefix="we-read-youtube-manuscript-", suffix=".json", delete=False) as output:
            output_path = output.name
        command = [
            codex_binary(), "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
            "--skip-git-repo-check", "--sandbox", "read-only", "-C", str(PROJECT),
            "-m", TERRA_MODEL, "-c", 'model_reasoning_effort="medium"', "--color", "never",
            "--output-schema", str(MANUSCRIPT_SCHEMA), "-o", output_path, "-",
        ]
        result = subprocess.run(
            command, input=prompt, text=True, capture_output=True, timeout=600, check=False,
            env=codex_environment(command[0]),
        )
        if result.returncode != 0:
            raise RuntimeError((result.stderr or result.stdout or "Terra Medium 中文文稿生成失败")[-1200:])
        parsed = json.loads(Path(output_path).read_text(encoding="utf-8"))
        paragraphs = parsed.get("paragraphs") or []
        expected = [segment["id"] for segment in segments]
        returned = [source_id for paragraph in paragraphs for source_id in paragraph.get("sourceIds", [])]
        if returned != expected:
            raise RuntimeError(f"中文文稿覆盖不完整：期望 {len(expected)} 个片段，返回 {len(returned)} 个")
        starts = {segment["id"]: int(segment["start"]) for segment in segments}
        normalized = []
        for paragraph in paragraphs:
            text = re.sub(r"\s+", " ", str(paragraph.get("text") or "")).strip()
            source_ids = paragraph.get("sourceIds") or []
            if not text or not source_ids:
                raise RuntimeError("Terra Medium 返回空段落")
            normalized.append({"start": starts[source_ids[0]], "sourceIds": source_ids, "text": text})
        title_zh = re.sub(r"\s+", " ", str(parsed.get("titleZh") or "")).strip()
        if not title_zh or not normalized:
            raise RuntimeError("Terra Medium 未返回完整中文文稿")
        return {"title": title_zh, "paragraphs": normalized}
    finally:
        if output_path:
            Path(output_path).unlink(missing_ok=True)


def summarize_with_terra(title: str, transcript: str) -> str:
    prompt = """你是长视频内容编辑。请完整理解下面的 YouTube Transcript，并输出一段简体中文梗概。
要求：
1. 只写一个自然段，约 180-300 个汉字；
2. 说明这期内容主要讨论什么、核心观点或框架、使用了哪些关键事实/案例，以及最后得出什么结论；
3. 保留重要人名、公司、产品、技术词和数字；
4. 不使用项目符号，不写“本视频/本期节目将会”，不评价质量，不添加原文没有的信息。

标题：
""" + title + "\n\nTranscript:\n" + transcript
    output_path = ""
    try:
        with tempfile.NamedTemporaryFile(prefix="we-read-youtube-summary-", suffix=".json", delete=False) as output:
            output_path = output.name
        command = [
            codex_binary(), "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
            "--skip-git-repo-check", "--sandbox", "read-only", "-C", str(PROJECT),
            "-m", TERRA_MODEL, "-c", 'model_reasoning_effort="high"', "--color", "never",
            "--output-schema", str(SUMMARY_SCHEMA), "-o", output_path, "-",
        ]
        result = subprocess.run(
            command, input=prompt, text=True, capture_output=True, timeout=420, check=False,
            env=codex_environment(command[0]),
        )
        if result.returncode != 0:
            raise RuntimeError((result.stderr or result.stdout or "Terra High 梗概生成失败")[-1200:])
        parsed = json.loads(Path(output_path).read_text(encoding="utf-8"))
        summary = re.sub(r"\s+", " ", str(parsed.get("summary") or "")).strip()
        if not summary:
            raise RuntimeError("Terra High 未返回梗概")
        return summary
    finally:
        if output_path:
            Path(output_path).unlink(missing_ok=True)


def coalesce_transcript_snippets(fetched: Any, target_chars: int = 5000) -> list[dict[str, Any]]:
    """Join sentence-level caption snippets into translation-sized paragraphs."""
    segments: list[dict[str, Any]] = []
    texts: list[str] = []
    start = 0
    chars = 0
    for snippet in fetched:
        text = re.sub(r"\s+", " ", html.unescape(snippet.text or "")).strip()
        if not text:
            continue
        if texts and chars + 1 + len(text) > target_chars:
            segments.append({"id": f"segment-{len(segments)}", "start": start, "text": " ".join(texts)})
            texts, chars = [], 0
        if not texts:
            start = max(0, int(snippet.start))
        texts.append(text)
        chars += len(text) + (1 if len(texts) > 1 else 0)
    if texts:
        segments.append({"id": f"segment-{len(segments)}", "start": start, "text": " ".join(texts)})
    return segments


def transcript_markdown(
    channel: dict[str, str], video: dict[str, Any], segments: list[dict[str, Any]],
    manuscript: dict[str, Any], language: str, is_generated: bool, provider: str,
    summary: str, summary_provider: str,
) -> str:
    translated_title = manuscript.get("title") or video["title"]
    lines = [
        "---",
        f"title: {yaml_string(translated_title)}",
        f"original_title: {yaml_string(video['title'])}",
        "platform: youtube",
        f"channel: {yaml_string(channel['name'])}",
        f"channel_id: {yaml_string(channel['channelId'])}",
        f"video_id: {yaml_string(video['videoId'])}",
        f"source: {yaml_string(video['url'])}",
        f"published_at: {yaml_string(video.get('publishedAt', ''))}",
        f"language: {yaml_string(language)}",
        f"is_generated: {str(bool(is_generated)).lower()}",
        f"manuscript_provider: {yaml_string(provider)}",
        f"summary: {yaml_string(summary)}",
        f"summary_provider: {yaml_string(summary_provider)}",
        'transcript_format: "contextual-v1"',
        f"captured_at: {yaml_string(now_iso())}",
        "---",
        "",
        f"# {translated_title}",
        "",
        f"> 英文标题：{video['title']}",
        "",
        f"> 频道：[{channel['name']}]({channel['url']}) · [观看视频]({video['url']})",
        "",
        "## 内容梗概",
        "",
        summary,
        "",
        "## 中文逐字文稿",
        "",
    ]
    for paragraph in manuscript.get("paragraphs", []):
        second = max(0, int(paragraph["start"]))
        lines.extend([f"[{time_label(second)}]({video['url']}&t={second}s) {paragraph['text']}", ""])
    lines.extend(["## English Transcript", ""])
    for segment in segments:
        second = max(0, int(segment["start"]))
        append_readable_segment(lines, video["url"], second, segment["text"], 450)
    return "\n".join(lines).rstrip() + "\n"


def reflow_markdown_text(value: str) -> str:
    if re.search(r"(?m)^transcript_format:\s*[\"']?readable-v3", value):
        return value
    if re.search(r"(?m)^transcript_format:\s*", value):
        value = re.sub(r"(?m)^transcript_format:\s*.*$", 'transcript_format: "readable-v3"', value, count=1)
    else:
        value = re.sub(
            r"(?m)^(translation_provider:\s*.*)$",
            r'\1\ntranscript_format: "readable-v3"', value, count=1,
        )
    lines = value.splitlines()
    output: list[str] = []
    section = ""
    timestamp = re.compile(r"^(\[[^\]]+\]\(https?://[^)]+\)\s+)(.*)$")
    for line in lines:
        if line == "## 中文译文":
            section = "zh"
        elif line == "## English Transcript":
            section = "en"
        if section and line and not line.startswith("## "):
            match = timestamp.match(line)
            prefix, prose = (match.group(1), match.group(2)) if match else ("", line)
            paragraphs = readable_paragraphs(prose, 220 if section == "zh" else 450)
            if paragraphs:
                output.append(prefix + paragraphs[0])
                for paragraph in paragraphs[1:]:
                    output.extend(["", paragraph])
                continue
        output.append(line)
    return "\n".join(output).rstrip() + "\n"


def archive_transcript(data_root: Path, channel: dict[str, str], video: dict[str, Any]) -> dict[str, Any]:
    if not video.get("t") or not video.get("publishedAt"):
        hydrate_video_metadata(video)
    transcript = select_transcript(YouTubeTranscriptApi(), video["videoId"])
    fetched = transcript.fetch()
    segments = coalesce_transcript_snippets(fetched, target_chars=700)
    if not segments:
        raise RuntimeError("字幕内容为空")
    original_transcript = "\n\n".join(segment["text"] for segment in segments)
    manuscript = manuscript_with_terra(video["title"], segments)
    translated_title = manuscript["title"]
    summary = summarize_with_terra(video["title"], original_transcript)
    published_day = (video.get("publishedAt") or "")[:10] or dt.date.today().isoformat()
    folder = f"{published_day} {safe_name(video['title'])}"
    target_dir = data_root / "文章" / "YouTube" / safe_name(channel["name"]) / folder
    markdown = target_dir / f"{folder}.md"
    target_dir.mkdir(parents=True, exist_ok=True)
    markdown.write_text(transcript_markdown(
        channel, video, segments, manuscript,
        str(getattr(transcript, "language_code", "")),
        bool(getattr(transcript, "is_generated", False)), MANUSCRIPT_PROVIDER,
        summary, SUMMARY_PROVIDER,
    ), encoding="utf-8")
    return {
        "sourceId": channel["sourceId"],
        "channel": channel["name"],
        "title": translated_title,
        "originalTitle": video["title"],
        "url": video["url"],
        "markdown": str(markdown.relative_to(data_root)),
        "language": getattr(transcript, "language_code", ""),
        "isGenerated": bool(getattr(transcript, "is_generated", False)),
        "manuscriptProvider": MANUSCRIPT_PROVIDER,
        "summary": summary,
        "summaryProvider": SUMMARY_PROVIDER,
        "archivedAt": now_iso(),
    }


def paths(data_root: Path) -> dict[str, Path]:
    return {
        "subscriptions": data_root / "数据" / "youtube-subscriptions.json",
        "status": data_root / "数据" / "youtube-status.json",
        "library": data_root / "数据" / "library.json",
    }


def subscribe(data_root: Path, url: str, initial_limit: int) -> dict[str, Any]:
    channel = resolve_channel(url)
    files = paths(data_root)
    config = read_json(files["subscriptions"], {"channels": [], "settings": {}})
    channels = config.setdefault("channels", [])
    existing = next((item for item in channels if item.get("channelId") == channel["channelId"]), None)
    record = {
        **channel,
        "platform": "youtube",
        "enabled": True,
        "initialVideoLimit": max(1, min(int(initial_limit), 15)),
        "addedAt": existing.get("addedAt") if existing else now_iso(),
    }
    if existing:
        existing.update(record)
    else:
        channels.append(record)
    config["updatedAt"] = now_iso()
    config.setdefault("settings", {}).setdefault("requestIntervalSeconds", 60)
    write_json(files["subscriptions"], config)
    return record


def merge_source(library: dict[str, Any], channel: dict[str, str], videos: list[dict[str, Any]]) -> None:
    sources = library.setdefault("sources", [])
    source = next((item for item in sources if item.get("bookId") == channel["sourceId"]), None)
    if source is None:
        source = {"name": channel["name"], "bookId": channel["sourceId"], "platform": "youtube", "items": []}
        sources.append(source)
    by_id = {item.get("rid") or item.get("url"): item for item in source.get("items", [])}
    for video in videos:
        by_id[video["rid"]] = video
    source.update({
        "name": channel["name"],
        "platform": "youtube",
        "channelId": channel["channelId"],
        "channelUrl": channel["url"],
        "items": sorted(by_id.values(), key=lambda item: item.get("t", 0), reverse=True),
    })


def update_library_item(library: dict[str, Any], source_id: str, video: dict[str, Any], archived: dict[str, Any]) -> None:
    source = next((item for item in library.get("sources", []) if item.get("bookId") == source_id), None)
    if not source:
        return
    item = next((entry for entry in source.get("items", []) if entry.get("rid") == video["rid"]), None)
    if not item:
        return
    item.update({
        "originalTitle": archived.get("originalTitle") or video["title"],
        "title": archived.get("title") or video["title"],
        "manuscriptProvider": archived.get("manuscriptProvider"),
        "summary": archived.get("summary") or item.get("summary") or "",
        "summaryProvider": archived.get("summaryProvider") or item.get("summaryProvider") or "",
        "t": int(video.get("t") or item.get("t") or 0),
        "publishedAt": video.get("publishedAt") or item.get("publishedAt") or "",
    })


def relocate_archive_to_published_date(data_root: Path, item: dict[str, Any], archived: dict[str, Any]) -> bool:
    markdown_value = str(archived.get("markdown") or "")
    published_day = str(item.get("publishedAt") or "")[:10]
    if not markdown_value or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", published_day):
        return False
    markdown = data_root / markdown_value
    if not markdown.is_file():
        return False
    old_dir = markdown.parent
    folder_suffix = re.sub(r"^\d{4}-\d{2}-\d{2}", "", old_dir.name)
    file_suffix = re.sub(r"^\d{4}-\d{2}-\d{2}", "", markdown.stem)
    target_dir = old_dir.with_name(published_day + folder_suffix)
    target_markdown = target_dir / (published_day + file_suffix + markdown.suffix)
    if target_markdown == markdown:
        return False
    if target_dir.exists():
        raise RuntimeError(f"目标归档目录已存在：{target_dir}")
    old_dir.rename(target_dir)
    moved_markdown = target_dir / markdown.name
    moved_markdown.rename(target_markdown)
    archived["markdown"] = str(target_markdown.relative_to(data_root))
    return True


def backfill_metadata(data_root: Path, delay: float = 1) -> dict[str, int]:
    files = paths(data_root)
    library = read_json(files["library"], {"updatedAt": None, "sources": []})
    status = read_json(files["status"], {"archived": {}, "failures": {}})
    scanned = updated = failed = relocated = 0
    candidates: list[dict[str, Any]] = []
    for source in library.get("sources", []):
        if source.get("platform") != "youtube":
            continue
        candidates.extend(item for item in source.get("items", []) if not item.get("t") or not item.get("publishedAt"))
    for index, item in enumerate(candidates):
        scanned += 1
        try:
            hydrate_video_metadata(item)
            archived = status.get("archived", {}).get(item.get("rid"), {})
            if archived:
                archived["publishedAt"] = item.get("publishedAt") or ""
                markdown_value = archived.get("markdown")
                if markdown_value:
                    markdown = data_root / markdown_value
                    if markdown.is_file():
                        text = markdown.read_text(encoding="utf-8")
                        text = re.sub(
                            r"(?m)^published_at:\s*.*$",
                            f"published_at: {yaml_string(item.get('publishedAt', ''))}", text, count=1,
                        )
                        markdown.write_text(text, encoding="utf-8")
            updated += 1
        except Exception as error:
            print(f"YouTube 日期回填失败 {item.get('videoId')}: {error}", file=sys.stderr)
            failed += 1
        if delay > 0 and index < len(candidates) - 1:
            time.sleep(delay)
    items_by_id = {
        item.get("rid"): item
        for source in library.get("sources", []) if source.get("platform") == "youtube"
        for item in source.get("items", []) if item.get("rid")
    }
    for rid, archived in status.get("archived", {}).items():
        item = items_by_id.get(rid)
        if not item:
            continue
        try:
            relocated += int(relocate_archive_to_published_date(data_root, item, archived))
        except Exception as error:
            print(f"YouTube 归档路径校正失败 {item.get('videoId')}: {error}", file=sys.stderr)
            failed += 1
    library["updatedAt"] = now_iso()
    status["updatedAt"] = now_iso()
    write_json(files["library"], library)
    write_json(files["status"], status)
    return {"scanned": scanned, "updated": updated, "relocated": relocated, "failed": failed}


def reflow_archives(data_root: Path, rid: str | None = None) -> dict[str, int]:
    files = paths(data_root)
    status = read_json(files["status"], {"archived": {}, "failures": {}})
    scanned = updated = missing = 0
    for article_id, archived in status.get("archived", {}).items():
        if rid and article_id != rid:
            continue
        scanned += 1
        markdown_value = str(archived.get("markdown") or "")
        markdown = data_root / markdown_value
        if not markdown_value or not markdown.is_file():
            missing += 1
            continue
        original = markdown.read_text(encoding="utf-8")
        formatted = reflow_markdown_text(original)
        if formatted != original:
            markdown.write_text(formatted, encoding="utf-8")
            updated += 1
        archived["transcriptFormat"] = "readable-v3"
    status["updatedAt"] = now_iso()
    write_json(files["status"], status)
    return {"scanned": scanned, "updated": updated, "missing": missing}


def backfill_summaries(data_root: Path, limit: int = 0) -> dict[str, int]:
    files = paths(data_root)
    library = read_json(files["library"], {"updatedAt": None, "sources": []})
    status = read_json(files["status"], {"archived": {}, "failures": {}})
    candidates: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for source in library.get("sources", []):
        if source.get("platform") != "youtube":
            continue
        for item in source.get("items", []):
            archived = status.get("archived", {}).get(item.get("rid"), {})
            if not item.get("summary") and archived.get("markdown"):
                candidates.append((item, archived))
    candidates.sort(key=lambda pair: int(pair[0].get("t") or 0), reverse=True)
    if limit > 0:
        candidates = candidates[:limit]
    generated = failed = 0
    for item, archived in candidates:
        try:
            markdown = data_root / str(archived["markdown"])
            raw = markdown.read_text(encoding="utf-8")
            transcript = raw.split("## English Transcript", 1)[-1]
            transcript = re.sub(r"\[[^\]]+\]\([^)]+\)\s*", "", transcript)
            transcript = re.sub(r"\s+", " ", transcript).strip()
            if not transcript:
                raise RuntimeError("本地英文 Transcript 为空")
            summary = summarize_with_terra(
                str(item.get("originalTitle") or item.get("title") or ""),
                transcript,
            )
            item["summary"] = summary
            item["summaryProvider"] = SUMMARY_PROVIDER
            archived["summary"] = summary
            archived["summaryProvider"] = SUMMARY_PROVIDER
            if not re.search(r"(?m)^summary:\s*", raw):
                raw = re.sub(
                    r"(?m)^(translation_provider:\s*.*)$",
                    rf"\1\nsummary: {yaml_string(summary)}\nsummary_provider: {yaml_string(SUMMARY_PROVIDER)}",
                    raw, count=1,
                )
            if "## 内容梗概" not in raw:
                raw = raw.replace("## 中文译文", f"## 内容梗概\n\n{summary}\n\n## 中文译文", 1)
            markdown.write_text(raw, encoding="utf-8")
            library["updatedAt"] = now_iso()
            status["updatedAt"] = now_iso()
            write_json(files["library"], library)
            write_json(files["status"], status)
            generated += 1
        except Exception as error:
            print(f"YouTube 梗概回填失败 {item.get('rid')}: {error}", file=sys.stderr)
            failed += 1
    return {"eligible": len(candidates), "generated": generated, "failed": failed}


def english_segments_from_markdown(raw: str) -> list[dict[str, Any]]:
    if "## English Transcript" not in raw:
        return []
    body = raw.split("## English Transcript", 1)[1]
    blocks = [block.strip() for block in re.split(r"\n\s*\n", body) if block.strip()]
    timestamp = re.compile(r"^\[[^\]]+\]\([^)]*[?&]t=(\d+)s\)\s*(.*)$", re.S)
    coarse: list[dict[str, Any]] = []
    current_start = 0
    for block in blocks:
        match = timestamp.match(block)
        if match:
            text = re.sub(r"\s+", " ", match.group(2)).strip()
            if text:
                current_start = int(match.group(1))
                coarse.append({"start": current_start, "text": text})
        elif coarse and not block.startswith("## "):
            coarse.append({"start": current_start, "text": re.sub(r"\s+", " ", block).strip()})
    segments: list[dict[str, Any]] = []
    for item in coarse:
        for paragraph in readable_paragraphs(item["text"], 700):
            segments.append({"id": f"segment-{len(segments)}", "start": item["start"], "text": paragraph})
    return segments


def manuscript_markdown(paragraphs: list[dict[str, Any]], video_url: str) -> str:
    lines = ["## 中文逐字文稿", ""]
    for paragraph in paragraphs:
        second = max(0, int(paragraph["start"]))
        lines.extend([f"[{time_label(second)}]({video_url}&t={second}s) {paragraph['text']}", ""])
    return "\n".join(lines).rstrip()


def backfill_manuscripts(data_root: Path, limit: int = 0) -> dict[str, int]:
    files = paths(data_root)
    library = read_json(files["library"], {"updatedAt": None, "sources": []})
    status = read_json(files["status"], {"archived": {}, "failures": {}})
    candidates: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for source in library.get("sources", []):
        if source.get("platform") != "youtube":
            continue
        for item in source.get("items", []):
            archived = status.get("archived", {}).get(item.get("rid"), {})
            if archived.get("markdown") and item.get("manuscriptProvider") != MANUSCRIPT_PROVIDER:
                candidates.append((item, archived))
    candidates.sort(key=lambda pair: int(pair[0].get("t") or 0), reverse=True)
    if limit > 0:
        candidates = candidates[:limit]
    generated = failed = 0
    for item, archived in candidates:
        try:
            markdown = data_root / str(archived["markdown"])
            raw = markdown.read_text(encoding="utf-8")
            segments = english_segments_from_markdown(raw)
            if not segments:
                raise RuntimeError("本地英文 Transcript 为空")
            manuscript = manuscript_with_terra(str(item.get("originalTitle") or item.get("title") or ""), segments)
            raw = re.sub(r"(?m)^title:\s*.*$", f"title: {yaml_string(manuscript['title'])}", raw, count=1)
            if re.search(r"(?m)^translation_provider:\s*", raw):
                raw = re.sub(r"(?m)^translation_provider:\s*.*$", f"manuscript_provider: {yaml_string(MANUSCRIPT_PROVIDER)}", raw, count=1)
            elif re.search(r"(?m)^manuscript_provider:\s*", raw):
                raw = re.sub(r"(?m)^manuscript_provider:\s*.*$", f"manuscript_provider: {yaml_string(MANUSCRIPT_PROVIDER)}", raw, count=1)
            else:
                raw = re.sub(r"(?m)^(is_generated:\s*.*)$", rf"\1\nmanuscript_provider: {yaml_string(MANUSCRIPT_PROVIDER)}", raw, count=1)
            raw = re.sub(r"(?m)^transcript_format:\s*.*$", 'transcript_format: "contextual-v1"', raw, count=1)
            replacement = manuscript_markdown(manuscript["paragraphs"], str(item.get("url") or archived.get("url") or ""))
            raw, replaced = re.subn(
                r"## (?:中文译文|中文逐字文稿)\s*\n[\s\S]*?(?=\n## English Transcript)",
                replacement + "\n", raw, count=1,
            )
            if replaced != 1:
                raise RuntimeError("找不到旧中文译文章节")
            markdown.write_text(raw, encoding="utf-8")
            item["title"] = manuscript["title"]
            item["manuscriptProvider"] = MANUSCRIPT_PROVIDER
            archived["title"] = manuscript["title"]
            archived["manuscriptProvider"] = MANUSCRIPT_PROVIDER
            archived.pop("translationProvider", None)
            library["updatedAt"] = status["updatedAt"] = now_iso()
            write_json(files["library"], library)
            write_json(files["status"], status)
            generated += 1
        except Exception as error:
            print(f"YouTube 中文文稿回填失败 {item.get('rid')}: {error}", file=sys.stderr)
            failed += 1
    return {"eligible": len(candidates), "generated": generated, "failed": failed}


def emit_progress(completed: int, total: int, archived: int, failed: int) -> None:
    print("WE_READ_YOUTUBE_PROGRESS " + json.dumps({
        "completed": completed, "total": total, "archived": archived, "failed": failed
    }), file=sys.stderr, flush=True)


def newer_discoveries(
    discovered: list[dict[str, Any]], existing_items: list[dict[str, Any]], limit: int,
) -> list[dict[str, Any]]:
    """Return genuinely newer videos, never older history outside the current shelf window."""
    existing_ids = {item.get("rid") for item in existing_items}
    latest_timestamp = max((int(item.get("t") or 0) for item in existing_items), default=0)
    return [
        item for item in discovered
        if item.get("rid") not in existing_ids
        and int(item.get("t") or 0) > latest_timestamp
    ][:limit]


def sync(
    data_root: Path, source_id: str | None, max_new: int, delay: float,
    initial_only: bool = False,
) -> dict[str, Any]:
    files = paths(data_root)
    config = read_json(files["subscriptions"], {"channels": [], "settings": {}})
    library = read_json(files["library"], {"updatedAt": None, "sources": []})
    status = read_json(files["status"], {"archived": {}, "failures": {}})
    channels = [item for item in config.get("channels", []) if item.get("enabled", True)]
    if source_id:
        channels = [item for item in channels if item.get("sourceId") == source_id]
    queue: list[tuple[dict[str, str], dict[str, Any]]] = []
    discovery_errors = []
    for channel in channels:
        try:
            discovered = discover(channel)
            existing_source = next((s for s in library.get("sources", []) if s.get("bookId") == channel["sourceId"]), None)
            existing_ids = {item.get("rid") for item in (existing_source or {}).get("items", [])}
            initial_limit = int(channel.get("initialVideoLimit") or 5)
            archived_ids = {
                rid for rid, entry in status.get("archived", {}).items()
                if entry.get("sourceId") == channel["sourceId"]
            }
            if existing_ids and not archived_ids:
                # Recover an interrupted first sync: keep the original initial
                # window instead of treating indexed-but-unarchived videos as
                # a completed channel and appending another max_new batch.
                initial = discovered[:initial_limit]
                if existing_source is not None:
                    existing_source["items"] = []
                merge_source(library, channel, initial)
                existing_source = next((s for s in library.get("sources", []) if s.get("bookId") == channel["sourceId"]), None)
                existing_ids = {item.get("rid") for item in (existing_source or {}).get("items", [])}
            if initial_only and existing_source is not None:
                # Initialization is a fixed newest-N window. This also repairs
                # an interrupted run that accidentally appended older history.
                existing_source["items"] = sorted(
                    existing_source.get("items", []), key=lambda item: item.get("t", 0), reverse=True,
                )[:initial_limit]
                existing_ids = {item.get("rid") for item in existing_source.get("items", [])}
            pending_existing = [
                item for item in discovered
                if item["rid"] in existing_ids and item["rid"] not in archived_ids
            ]
            selected = [] if pending_existing or initial_only else newer_discoveries(
                discovered, (existing_source or {}).get("items", []), max_new,
            )
            if not existing_ids:
                selected = discovered[:initial_limit]
            merge_source(library, channel, selected)
            retryable = [item for item in discovered if item["rid"] in status.get("failures", {})]
            candidates = pending_existing + selected
            candidate_ids = {item["rid"] for item in candidates}
            candidates += [item for item in retryable if item["rid"] not in candidate_ids]
            for video in candidates[:max_new]:
                if video["rid"] not in status.get("archived", {}):
                    queue.append((channel, video))
            channel["lastSyncedAt"] = now_iso()
        except Exception as error:
            discovery_errors.append({"sourceId": channel.get("sourceId"), "error": str(error)})
    library["updatedAt"] = now_iso()
    config["updatedAt"] = now_iso()
    write_json(files["library"], library)
    write_json(files["subscriptions"], config)
    completed = archived = failed = 0
    emit_progress(0, len(queue), 0, 0)
    for index, (channel, video) in enumerate(queue):
        try:
            archived_entry = archive_transcript(data_root, channel, video)
            status.setdefault("archived", {})[video["rid"]] = archived_entry
            status.setdefault("failures", {}).pop(video["rid"], None)
            update_library_item(library, channel["sourceId"], video, archived_entry)
            library["updatedAt"] = now_iso()
            write_json(files["library"], library)
            archived += 1
        except Exception as error:
            status.setdefault("failures", {})[video["rid"]] = {
                "sourceId": channel["sourceId"],
                "channel": channel["name"],
                "title": video["title"],
                "url": video["url"],
                "error": f"{error.__class__.__name__}: {error}",
                "attemptedAt": now_iso(),
            }
            failed += 1
        completed += 1
        status["updatedAt"] = now_iso()
        write_json(files["status"], status)
        emit_progress(completed, len(queue), archived, failed)
        if delay > 0 and index < len(queue) - 1:
            time.sleep(delay)
    return {
        "channels": len(channels),
        "videosDiscovered": sum(len(source.get("items", [])) for source in library.get("sources", []) if source.get("platform") == "youtube"),
        "queued": len(queue),
        "archived": archived,
        "failed": failed,
        "discoveryErrors": discovery_errors,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="YouTube integration for We-Read")
    parser.add_argument("--data-root", default=str(DEFAULT_DATA))
    commands = parser.add_subparsers(dest="command", required=True)
    resolve = commands.add_parser("resolve")
    resolve.add_argument("url")
    add = commands.add_parser("subscribe")
    add.add_argument("url")
    add.add_argument("--initial-limit", type=int, default=5)
    run = commands.add_parser("sync")
    run.add_argument("--source-id")
    run.add_argument("--max-new", type=int, default=10)
    run.add_argument("--delay", type=float, default=60)
    run.add_argument("--initial-only", action="store_true")
    metadata = commands.add_parser("backfill-metadata")
    metadata.add_argument("--delay", type=float, default=1)
    reflow = commands.add_parser("reflow-archives")
    reflow.add_argument("--rid")
    summaries = commands.add_parser("backfill-summaries")
    summaries.add_argument("--limit", type=int, default=0)
    manuscripts = commands.add_parser("backfill-manuscripts")
    manuscripts.add_argument("--limit", type=int, default=0)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    data_root = Path(args.data_root).expanduser().resolve()
    if args.command == "resolve":
        result = resolve_channel(args.url)
    elif args.command == "subscribe":
        result = subscribe(data_root, args.url, args.initial_limit)
    elif args.command == "sync":
        result = sync(
            data_root, args.source_id, max(1, min(args.max_new, 15)), max(0, args.delay),
            initial_only=args.initial_only,
        )
    elif args.command == "reflow-archives":
        result = reflow_archives(data_root, args.rid)
    elif args.command == "backfill-summaries":
        result = backfill_summaries(data_root, max(0, args.limit))
    elif args.command == "backfill-manuscripts":
        result = backfill_manuscripts(data_root, max(0, args.limit))
    else:
        result = backfill_metadata(data_root, max(0, args.delay))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
