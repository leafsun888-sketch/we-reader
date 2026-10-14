#!/usr/bin/env python3
"""Xiaoyuzhou subscriptions, local transcription, and long-form archiving."""

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
from pathlib import Path
from typing import Any


PROJECT = Path(__file__).resolve().parent.parent
DEFAULT_DATA = PROJECT / "data"
HOSTS = {"xiaoyuzhoufm.com", "www.xiaoyuzhoufm.com"}
SUMMARY_MODEL = "gpt-5.6-terra"
SUMMARY_PROVIDER = "codex:gpt-5.6-terra:high"
SUMMARY_SCHEMA = Path(__file__).with_name("summary.schema.json")
MANUSCRIPT_PROVIDER = "codex:gpt-5.6-terra:medium:lossless-v1"
MANUSCRIPT_SCHEMA = Path(__file__).with_name("manuscript.schema.json")
WHISPER_MODEL = os.environ.get("WE_READ_WHISPER_MODEL", "mlx-community/whisper-small-mlx")


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f"{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, path)


def paths(data_root: Path) -> dict[str, Path]:
    return {
        "subscriptions": data_root / "数据" / "podcast-subscriptions.json",
        "status": data_root / "数据" / "podcast-status.json",
        "library": data_root / "数据" / "library.json",
    }


def safe_name(value: str) -> str:
    clean = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "-", html.unescape(value or ""))
    return re.sub(r"\s+", " ", clean).strip(" .-")[:120] or "episode"


def fetch_page(url: str) -> str:
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 We-Read/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8")


def next_data(url: str) -> dict[str, Any]:
    page = fetch_page(url)
    match = re.search(r'<script id="__NEXT_DATA__" type="application/json">([\s\S]*?)</script>', page)
    if not match:
        raise RuntimeError("小宇宙公开页面没有可解析的节目数据")
    return json.loads(match.group(1)).get("props", {}).get("pageProps", {})


def normalize_url(value: str) -> str:
    parsed = urllib.parse.urlparse(value.strip())
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in HOSTS:
        raise ValueError("请输入 xiaoyuzhoufm.com 的节目主页或单集链接")
    match = re.fullmatch(r"/(podcast|episode)/([A-Za-z0-9]+)", parsed.path.rstrip("/"))
    if not match:
        raise ValueError("小宇宙链接应为 /podcast/... 或 /episode/...")
    return f"https://www.xiaoyuzhoufm.com/{match.group(1)}/{match.group(2)}"


def resolve_podcast(value: str) -> dict[str, Any]:
    url = normalize_url(value)
    props = next_data(url)
    podcast = props.get("podcast")
    if not podcast:
        episode = props.get("episode") or {}
        podcast = episode.get("podcast")
    pid = str((podcast or {}).get("pid") or "")
    if not pid:
        raise RuntimeError("未能从小宇宙页面识别节目")
    if not (podcast or {}).get("episodes"):
        podcast = next_data(f"https://www.xiaoyuzhoufm.com/podcast/{pid}").get("podcast")
    if not podcast:
        raise RuntimeError("未能读取小宇宙节目资料")
    return {
        "podcastId": pid,
        "sourceId": f"XYZ_PODCAST_{pid}",
        "name": str(podcast.get("title") or pid),
        "author": str(podcast.get("author") or ""),
        "description": str(podcast.get("description") or podcast.get("brief") or ""),
        "url": f"https://www.xiaoyuzhoufm.com/podcast/{pid}",
        "episodes": podcast.get("episodes") or [],
    }


def parse_time(value: str) -> int:
    try:
        return int(dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())
    except (TypeError, ValueError):
        return 0


def discover(podcast: dict[str, Any]) -> list[dict[str, Any]]:
    current = resolve_podcast(podcast["url"])
    episodes = []
    for episode in current.get("episodes", []):
        eid = str(episode.get("eid") or "")
        enclosure = str((episode.get("enclosure") or {}).get("url") or (episode.get("media") or {}).get("source", {}).get("url") or "")
        if not eid or not enclosure or episode.get("isPrivateMedia"):
            continue
        published = str(episode.get("pubDate") or "")
        episodes.append({
            "rid": f"XYZ_EPISODE_{eid}",
            "episodeId": eid,
            "title": str(episode.get("title") or eid),
            "description": str(episode.get("description") or ""),
            "url": f"https://www.xiaoyuzhoufm.com/episode/{eid}",
            "audioUrl": enclosure,
            "duration": int(episode.get("duration") or 0),
            "publishedAt": published,
            "t": parse_time(published),
        })
    return sorted(episodes, key=lambda item: (item["t"], item["episodeId"]), reverse=True)


def codex_binary() -> str:
    binary = shutil.which("codex") or str(Path.home() / ".local" / "bin" / "codex")
    if not Path(binary).exists():
        raise RuntimeError("找不到 Codex CLI，无法生成长内容梗概")
    return binary


def codex_environment(binary: str) -> dict[str, str]:
    environment = os.environ.copy()
    directories = [str(Path(binary).resolve().parent), str(Path.home() / ".local" / "bin")]
    directories.extend(value for value in environment.get("PATH", "").split(os.pathsep) if value)
    environment["PATH"] = os.pathsep.join(dict.fromkeys(directories))
    return environment


def summarize(title: str, transcript: str) -> str:
    prompt = """你是中文播客内容编辑。完整理解下面的逐字稿，输出一段 180-300 字的中文梗概。
说明主要议题、核心观点或框架、关键事实/案例和结论。只写一个自然段，不用项目符号，不评价节目质量，不添加逐字稿没有的信息。

标题：
""" + title + "\n\n逐字稿：\n" + transcript
    with tempfile.NamedTemporaryFile(prefix="we-read-podcast-summary-", suffix=".json", delete=False) as output:
        output_path = Path(output.name)
    try:
        binary = codex_binary()
        command = [
            binary, "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
            "--skip-git-repo-check", "--sandbox", "read-only", "-C", str(PROJECT),
            "-m", SUMMARY_MODEL, "-c", 'model_reasoning_effort="high"', "--color", "never",
            "--output-schema", str(SUMMARY_SCHEMA), "-o", str(output_path), "-",
        ]
        result = subprocess.run(command, input=prompt, text=True, capture_output=True, timeout=420, env=codex_environment(binary))
        if result.returncode:
            raise RuntimeError((result.stderr or result.stdout)[-1200:])
        summary = re.sub(r"\s+", " ", str(json.loads(output_path.read_text()).get("summary") or "")).strip()
        if not summary:
            raise RuntimeError("Terra High 未返回小宇宙梗概")
        return summary
    finally:
        output_path.unlink(missing_ok=True)


def coalesce_segments(segments: list[dict[str, Any]], target_chars: int = 900) -> list[dict[str, Any]]:
    units: list[dict[str, Any]] = []
    texts: list[str] = []
    start = 0
    for segment in segments:
        text = re.sub(r"\s+", " ", str(segment.get("text") or "")).strip()
        if not text:
            continue
        if texts and sum(len(item) for item in texts) + len(text) > target_chars:
            units.append({"id": f"s{len(units) + 1:04d}", "start": start, "text": " ".join(texts)})
            texts = []
        if not texts:
            start = int(float(segment.get("start") or 0))
        texts.append(text)
    if texts:
        units.append({"id": f"s{len(units) + 1:04d}", "start": start, "text": " ".join(texts)})
    return units


def manuscript_with_terra(title: str, segments: list[dict[str, Any]]) -> dict[str, Any]:
    payload = [{"id": item["id"], "startSeconds": item["start"], "text": item["text"]} for item in segments]
    prompt = """你是中文播客逐字稿编辑。请先完整阅读所有 Whisper 转录片段，再整理成一份通顺、忠实、可连续阅读的中文文稿。

这不是摘要。规则：
1. 不遗漏任何有意义的信息，包括事实、数字、例子、问题、回答、限定条件、转折、论证顺序和结论；
2. 利用全文上下文修复错误断句、缺失标点、机械重复、口误式重复和明显 ASR 同音字错误，但不得添加原话没有的信息；
3. 删除纯粹无语义的语气词和转录噪声；有表达意义的犹豫、强调和态度必须保留；
4. 将口语整理成自然、准确的书面中文，但不要概括、压缩或改写观点；
5. 按话题转换和自然语义合理分段，每段通常 3-7 句。没有可靠说话人信息时，不得猜测或虚构姓名；
6. 每个输入 id 必须且只能出现在某一个 paragraph.sourceIds 中，sourceIds 必须保持输入顺序，以便审计是否遗漏；
7. titleZh 使用忠实、自然的中文标题。

输入：
""" + json.dumps({"title": title, "segments": payload}, ensure_ascii=False)
    with tempfile.NamedTemporaryFile(prefix="we-read-podcast-manuscript-", suffix=".json", delete=False) as output:
        output_path = Path(output.name)
    try:
        binary = codex_binary()
        command = [
            binary, "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral",
            "--skip-git-repo-check", "--sandbox", "read-only", "-C", str(PROJECT),
            "-m", SUMMARY_MODEL, "-c", 'model_reasoning_effort="medium"', "--color", "never",
            "--output-schema", str(MANUSCRIPT_SCHEMA), "-o", str(output_path), "-",
        ]
        result = subprocess.run(command, input=prompt, text=True, capture_output=True, timeout=900, env=codex_environment(binary))
        if result.returncode:
            raise RuntimeError((result.stderr or result.stdout or "Terra Medium 未生成整理文稿")[-1200:])
        parsed = json.loads(output_path.read_text(encoding="utf-8"))
        paragraphs = parsed.get("paragraphs") or []
        expected = [item["id"] for item in segments]
        returned = [source_id for paragraph in paragraphs for source_id in paragraph.get("sourceIds", [])]
        if returned != expected:
            raise RuntimeError(f"整理文稿覆盖不完整：期望 {len(expected)} 个片段，返回 {len(returned)} 个")
        starts = {item["id"]: item["start"] for item in segments}
        normalized = []
        for paragraph in paragraphs:
            text = re.sub(r"\s+", " ", str(paragraph.get("text") or "")).strip()
            source_ids = paragraph.get("sourceIds") or []
            if not text or not source_ids:
                raise RuntimeError("Terra Medium 返回空段落")
            normalized.append({"start": starts[source_ids[0]], "sourceIds": source_ids, "text": text})
        if not normalized:
            raise RuntimeError("Terra Medium 未返回整理文稿")
        return {"title": re.sub(r"\s+", " ", str(parsed.get("titleZh") or title)).strip(), "paragraphs": normalized}
    finally:
        output_path.unlink(missing_ok=True)


def time_label(seconds: int) -> str:
    hours, rest = divmod(max(0, int(seconds)), 3600)
    minutes, seconds = divmod(rest, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes:02d}:{seconds:02d}"


def manuscript_lines(paragraphs: list[dict[str, Any]]) -> list[str]:
    lines: list[str] = []
    for paragraph in paragraphs:
        lines.extend([f"**[{time_label(paragraph['start'])}]** {paragraph['text']}", ""])
    return lines


def whisper_binary() -> str:
    configured = os.environ.get("WE_READ_MLX_WHISPER")
    candidates = [configured, shutil.which("mlx_whisper"), str(Path.home() / "Library/Python/3.9/bin/mlx_whisper")]
    binary = next((value for value in candidates if value and Path(value).is_file()), None)
    if not binary:
        raise RuntimeError("未安装 mlx-whisper，无法在本机转录小宇宙音频")
    return binary


def transcribe(audio_url: str) -> tuple[str, list[dict[str, Any]]]:
    with tempfile.TemporaryDirectory(prefix="we-read-podcast-") as directory:
        work = Path(directory)
        audio = work / "episode.m4a"
        request = urllib.request.Request(audio_url, headers={"User-Agent": "Mozilla/5.0 We-Read/1.0"})
        with urllib.request.urlopen(request, timeout=120) as response, audio.open("wb") as output:
            shutil.copyfileobj(response, output)
        binary = whisper_binary()
        command = [
            binary, str(audio), "--model", WHISPER_MODEL,
            "--output-dir", str(work), "--output-name", "transcript",
            "--output-format", "json", "--verbose", "False",
        ]
        result = subprocess.run(command, text=True, capture_output=True, timeout=7200, env=codex_environment(binary))
        transcript_file = work / "transcript.json"
        if result.returncode or not transcript_file.is_file():
            raise RuntimeError((result.stderr or result.stdout or "mlx-whisper 未生成逐字稿")[-1200:])
        payload = json.loads(transcript_file.read_text(encoding="utf-8"))
        text = re.sub(r"\s+", " ", str(payload.get("text") or "")).strip()
        segments = [
            {"start": float(item.get("start") or 0), "text": re.sub(r"\s+", " ", str(item.get("text") or "")).strip()}
            for item in payload.get("segments", []) if str(item.get("text") or "").strip()
        ]
        if not text:
            raise RuntimeError("mlx-whisper 返回空逐字稿")
        return text, segments


def archive(data_root: Path, podcast: dict[str, Any], episode: dict[str, Any]) -> dict[str, Any]:
    transcript, segments = transcribe(episode["audioUrl"])
    day = episode.get("publishedAt", "")[:10] or dt.date.today().isoformat()
    folder = f"{day} {safe_name(episode['title'])}"
    target = data_root / "文章" / "小宇宙" / safe_name(podcast["name"]) / folder / f"{folder}.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    raw_target = target.with_name(f"{folder}.transcript.json")
    write_json(raw_target, {"title": episode["title"], "provider": f"mlx-whisper/{WHISPER_MODEL}", "segments": segments, "text": transcript})
    summary = summarize(episode["title"], transcript)
    manuscript = manuscript_with_terra(episode["title"], coalesce_segments(segments))
    lines = [
        "---", f"title: {json.dumps(episode['title'], ensure_ascii=False)}", "platform: podcast",
        f"podcast: {json.dumps(podcast['name'], ensure_ascii=False)}",
        f"episode_id: {json.dumps(episode['episodeId'])}",
        f"source: {json.dumps(episode['url'])}",
        f"published_at: {json.dumps(episode.get('publishedAt', ''))}",
        f"summary: {json.dumps(summary, ensure_ascii=False)}",
        f"summary_provider: {json.dumps(SUMMARY_PROVIDER)}",
        f"manuscript_provider: {json.dumps(MANUSCRIPT_PROVIDER)}",
        f"transcript_provider: {json.dumps('mlx-whisper/' + WHISPER_MODEL)}",
        f"raw_transcript: {json.dumps(str(raw_target.relative_to(data_root)), ensure_ascii=False)}",
        f"captured_at: {json.dumps(now_iso())}", "---", "",
        f"# {episode['title']}", "", f"> 节目：[{podcast['name']}]({podcast['url']}) · [在小宇宙收听]({episode['url']})", "",
        "## 内容梗概", "", summary, "", "## 节目简介", "", episode.get("description") or "暂无节目简介。", "",
        "## 整理文稿", "",
    ]
    lines.extend(manuscript_lines(manuscript["paragraphs"]))
    target.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    return {
        "sourceId": podcast["sourceId"], "podcast": podcast["name"], "title": episode["title"],
        "url": episode["url"], "markdown": str(target.relative_to(data_root)),
        "summary": summary, "summaryProvider": SUMMARY_PROVIDER,
        "manuscriptProvider": MANUSCRIPT_PROVIDER,
        "transcriptProvider": f"mlx-whisper/{WHISPER_MODEL}", "archivedAt": now_iso(),
    }


def merge_source(library: dict[str, Any], podcast: dict[str, Any], episodes: list[dict[str, Any]]) -> None:
    sources = library.setdefault("sources", [])
    source = next((item for item in sources if item.get("bookId") == podcast["sourceId"]), None)
    if source is None:
        source = {"bookId": podcast["sourceId"], "items": []}
        sources.append(source)
    by_id = {item.get("rid"): item for item in source.get("items", []) if item.get("rid")}
    by_id.update({item["rid"]: item for item in episodes})
    source.update({
        "name": podcast["name"], "platform": "podcast", "podcastId": podcast["podcastId"],
        "podcastUrl": podcast["url"], "items": sorted(by_id.values(), key=lambda item: item.get("t", 0), reverse=True),
    })


def update_item(library: dict[str, Any], source_id: str, episode: dict[str, Any], archived: dict[str, Any]) -> None:
    source = next((item for item in library.get("sources", []) if item.get("bookId") == source_id), None)
    item = next((item for item in (source or {}).get("items", []) if item.get("rid") == episode["rid"]), None)
    if item:
        item.update({"summary": archived["summary"], "summaryProvider": archived["summaryProvider"], "manuscriptProvider": archived.get("manuscriptProvider")})


def subscribe(data_root: Path, value: str, initial_limit: int) -> dict[str, Any]:
    podcast = resolve_podcast(value)
    files = paths(data_root)
    config = read_json(files["subscriptions"], {"podcasts": [], "settings": {}})
    record = {key: podcast[key] for key in ("podcastId", "sourceId", "name", "author", "description", "url")}
    existing = next((item for item in config.setdefault("podcasts", []) if item.get("podcastId") == record["podcastId"]), None)
    record.update({"enabled": True, "initialEpisodeLimit": max(1, min(int(initial_limit), 10)), "addedAt": existing.get("addedAt") if existing else now_iso()})
    if existing:
        existing.update(record)
    else:
        config["podcasts"].append(record)
    config["updatedAt"] = now_iso()
    write_json(files["subscriptions"], config)
    return record


def sync(data_root: Path, source_id: str | None, max_new: int) -> dict[str, Any]:
    files = paths(data_root)
    config = read_json(files["subscriptions"], {"podcasts": [], "settings": {}})
    library = read_json(files["library"], {"updatedAt": None, "sources": []})
    status = read_json(files["status"], {"archived": {}, "failures": {}})
    podcasts = [item for item in config.get("podcasts", []) if item.get("enabled", True)]
    if source_id:
        podcasts = [item for item in podcasts if item.get("sourceId") == source_id]
    queue = []
    for podcast in podcasts:
        episodes = discover(podcast)
        source = next((item for item in library.get("sources", []) if item.get("bookId") == podcast["sourceId"]), None)
        existing = (source or {}).get("items", [])
        existing_ids = {item.get("rid") for item in existing}
        archived_ids = set(status.get("archived", {}))
        if not existing:
            selected = episodes[:int(podcast.get("initialEpisodeLimit") or 3)]
            merge_source(library, podcast, selected)
        else:
            latest = max((int(item.get("t") or 0) for item in existing), default=0)
            selected = [item for item in episodes if item["rid"] not in existing_ids and item["t"] > latest][:max_new]
            merge_source(library, podcast, selected)
        source = next((item for item in library.get("sources", []) if item.get("bookId") == podcast["sourceId"]), None)
        queue.extend((podcast, item) for item in source.get("items", []) if item["rid"] not in archived_ids)
        podcast["lastSyncedAt"] = now_iso()
    library["updatedAt"] = now_iso()
    config["updatedAt"] = now_iso()
    write_json(files["library"], library)
    write_json(files["subscriptions"], config)
    completed = archived_count = failed = 0
    print("WE_READ_PODCAST_PROGRESS " + json.dumps({"completed": 0, "total": len(queue), "archived": 0, "failed": 0}), file=sys.stderr, flush=True)
    for podcast, episode in queue:
        try:
            result = archive(data_root, podcast, episode)
            status.setdefault("archived", {})[episode["rid"]] = result
            status.setdefault("failures", {}).pop(episode["rid"], None)
            update_item(library, podcast["sourceId"], episode, result)
            archived_count += 1
        except Exception as error:
            status.setdefault("failures", {})[episode["rid"]] = {
                "sourceId": podcast["sourceId"], "title": episode["title"], "url": episode["url"],
                "error": f"{error.__class__.__name__}: {error}", "attemptedAt": now_iso(),
            }
            failed += 1
        completed += 1
        library["updatedAt"] = status["updatedAt"] = now_iso()
        write_json(files["library"], library)
        write_json(files["status"], status)
        print("WE_READ_PODCAST_PROGRESS " + json.dumps({"completed": completed, "total": len(queue), "archived": archived_count, "failed": failed}), file=sys.stderr, flush=True)
    return {"podcasts": len(podcasts), "queued": len(queue), "archived": archived_count, "failed": failed}


def legacy_segments(raw: str) -> list[dict[str, Any]]:
    segments = []
    for minutes, seconds, text in re.findall(r"(?m)^\*\*\[(\d+):(\d{2})\]\*\*\s+(.+)$", raw):
        segments.append({"start": int(minutes) * 60 + int(seconds), "text": text.strip()})
    return segments


def set_frontmatter(raw: str, key: str, value: str) -> str:
    rendered = f"{key}: {json.dumps(value, ensure_ascii=False)}"
    if re.search(rf"(?m)^{re.escape(key)}:\s*.*$", raw):
        return re.sub(rf"(?m)^{re.escape(key)}:\s*.*$", rendered, raw, count=1)
    closing = raw.find("\n---", 4) if raw.startswith("---\n") else -1
    if closing < 0:
        raise RuntimeError("Markdown 缺少 frontmatter")
    return raw[:closing] + "\n" + rendered + raw[closing:]


def backfill_manuscripts(data_root: Path, limit: int = 0) -> dict[str, int]:
    files = paths(data_root)
    library = read_json(files["library"], {"sources": []})
    status = read_json(files["status"], {"archived": {}, "failures": {}})
    candidates = []
    for source in library.get("sources", []):
        if source.get("platform") != "podcast":
            continue
        for item in source.get("items", []):
            archived = status.get("archived", {}).get(item.get("rid"))
            if archived and item.get("manuscriptProvider") != MANUSCRIPT_PROVIDER:
                candidates.append((source, item, archived))
    if limit:
        candidates = candidates[:limit]
    completed = failed = 0
    for source, item, archived in candidates:
        try:
            target = data_root / archived["markdown"]
            raw = target.read_text(encoding="utf-8")
            segments = legacy_segments(raw)
            if not segments:
                raise RuntimeError("旧 Markdown 中没有可回填的 Whisper 片段")
            manuscript = manuscript_with_terra(str(item.get("title") or ""), coalesce_segments(segments))
            raw_target = target.with_name(target.stem + ".transcript.json")
            write_json(raw_target, {"title": item.get("title"), "provider": archived.get("transcriptProvider"), "segments": segments, "text": " ".join(segment["text"] for segment in segments)})
            replacement = "## 整理文稿\n\n" + "\n".join(manuscript_lines(manuscript["paragraphs"])).rstrip() + "\n"
            raw = re.sub(r"(?s)## (?:逐字稿|整理文稿)\s*\n.*$", replacement, raw)
            raw = set_frontmatter(raw, "manuscript_provider", MANUSCRIPT_PROVIDER)
            raw = set_frontmatter(raw, "raw_transcript", str(raw_target.relative_to(data_root)))
            target.write_text(raw.rstrip() + "\n", encoding="utf-8")
            item["manuscriptProvider"] = MANUSCRIPT_PROVIDER
            archived["manuscriptProvider"] = MANUSCRIPT_PROVIDER
            archived["rawTranscript"] = str(raw_target.relative_to(data_root))
            completed += 1
        except Exception as error:
            failed += 1
            status.setdefault("failures", {})[item.get("rid")] = {
                "sourceId": source.get("bookId"), "title": item.get("title"), "url": item.get("url"),
                "error": f"{error.__class__.__name__}: {error}", "attemptedAt": now_iso(),
            }
        library["updatedAt"] = status["updatedAt"] = now_iso()
        write_json(files["library"], library)
        write_json(files["status"], status)
        print("WE_READ_PODCAST_MANUSCRIPT_PROGRESS " + json.dumps({"completed": completed, "failed": failed, "total": len(candidates)}), file=sys.stderr, flush=True)
    return {"queued": len(candidates), "completed": completed, "failed": failed}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", default=str(DEFAULT_DATA))
    commands = parser.add_subparsers(dest="command", required=True)
    resolve = commands.add_parser("resolve"); resolve.add_argument("url")
    add = commands.add_parser("subscribe"); add.add_argument("url"); add.add_argument("--initial-limit", type=int, default=3)
    run = commands.add_parser("sync"); run.add_argument("--source-id"); run.add_argument("--max-new", type=int, default=3)
    backfill = commands.add_parser("backfill-manuscripts"); backfill.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    root = Path(args.data_root).expanduser().resolve()
    if args.command == "resolve":
        result = resolve_podcast(args.url)
        result.pop("episodes", None)
    elif args.command == "subscribe":
        result = subscribe(root, args.url, args.initial_limit)
    elif args.command == "backfill-manuscripts":
        result = backfill_manuscripts(root, max(0, args.limit))
    else:
        result = sync(root, args.source_id, max(1, min(args.max_new, 10)))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
