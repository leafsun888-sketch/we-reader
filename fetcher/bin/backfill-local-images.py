#!/usr/bin/env python3
"""把已归档 Markdown 仍引用的远程图片补存到本地 assets 目录。

逐张串行下载；每篇文章完成后原子写回 Markdown，因此中断后可直接重跑。
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path


IMAGE = re.compile(r"!\[([^\]]*)\]\((https?://[^\s)]+)\)")


def source_url(markdown: str) -> str:
    match = re.search(r'^source:\s*"?([^"\n]+)', markdown, re.MULTILINE)
    return match.group(1).strip() if match else "https://mp.weixin.qq.com/"


def extension(url: str, content_type: str) -> str:
    suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"}:
        return suffix
    guessed = mimetypes.guess_extension(content_type.split(";", 1)[0].strip())
    return guessed if guessed in {".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"} else ".jpg"


def fetch_image(url: str, referer: str) -> tuple[bytes, str]:
    request = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Referer": referer,
    })
    with urllib.request.urlopen(request, timeout=35) as response:
        body = response.read()
        content_type = response.headers.get("Content-Type", "")
        final_url = response.geturl()
    if not body or (not content_type.lower().startswith("image/") and not body.startswith((b"\x89PNG", b"\xff\xd8\xff", b"GIF8", b"RIFF"))):
        raise ValueError(f"响应不是图片 ({content_type or 'unknown'})")
    return body, extension(final_url, content_type)


def atomic_write(path: Path, text: str) -> None:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        handle.write(text)
        temp = Path(handle.name)
    os.replace(temp, path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[2] / "data"))
    parser.add_argument("--delay", type=float, default=0.35, help="每张图片之间的等待秒数")
    parser.add_argument("--max-images", type=int, default=0, help="0 表示全部；用于分批或测试")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    articles = root / "文章"
    status_path = root / "数据" / "image-backfill-status.json"
    status = {"startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "completed": 0, "failed": 0, "files": 0, "failures": []}
    if status_path.exists():
        try:
            status.update(json.loads(status_path.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            pass

    downloaded_this_run = 0
    for markdown_path in sorted(articles.rglob("*.md")):
        if args.max_images and downloaded_this_run >= args.max_images:
            break
        original = markdown_path.read_text(encoding="utf-8")
        urls = list(dict.fromkeys(match.group(2) for match in IMAGE.finditer(original)))
        if not urls:
            continue
        assets = markdown_path.parent / "assets"
        assets.mkdir(exist_ok=True)
        replacements: dict[str, str] = {}
        for url in urls:
            if args.max_images and downloaded_this_run >= args.max_images:
                break
            try:
                body, suffix = fetch_image(url, source_url(original))
                name = f"image-local-{downloaded_this_run + 1:05d}{suffix}"
                target = assets / name
                while target.exists():
                    name = f"image-local-{downloaded_this_run + 1:05d}-{int(time.time() * 1000) % 100000}{suffix}"
                    target = assets / name
                target.write_bytes(body)
                replacements[url] = f"assets/{name}"
                downloaded_this_run += 1
                status["completed"] = int(status.get("completed", 0)) + 1
                time.sleep(max(0, args.delay))
            except Exception as exc:  # Keep the original remote link so a later run can retry it.
                status["failed"] = int(status.get("failed", 0)) + 1
                status.setdefault("failures", []).append({"markdown": str(markdown_path.relative_to(root)), "url": url, "error": str(exc), "at": time.strftime("%Y-%m-%dT%H:%M:%S%z")})
        if replacements:
            updated = original
            for remote, local in replacements.items():
                updated = updated.replace(f"]({remote})", f"]({local})")
            atomic_write(markdown_path, updated)
            status["files"] = int(status.get("files", 0)) + 1
        status["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        status_path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write(status_path, json.dumps(status, ensure_ascii=False, indent=2) + "\n")
        if downloaded_this_run and downloaded_this_run % 25 == 0:
            print(json.dumps({"downloadedThisRun": downloaded_this_run, "completed": status["completed"], "failed": status["failed"]}, ensure_ascii=False), flush=True)

    status["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    atomic_write(status_path, json.dumps(status, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"downloadedThisRun": downloaded_this_run, "completed": status["completed"], "failed": status["failed"], "status": str(status_path)}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
