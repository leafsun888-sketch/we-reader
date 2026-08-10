#!/usr/bin/env python3
"""Save one WeChat public-account article as local Markdown and assets.

This small, standard-library-only converter is bundled with We-Read so a clone
does not depend on a Codex installation or an unpinned Python package. It is
intended for articles the user can legitimately access; it does not bypass
CAPTCHA, login, or access controls.
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import mimetypes
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path


CAPTCHA_MARKERS = (
    "wappoc_appmsgcaptcha",
    "poc_token",
    "环境异常",
    "访问过于频繁",
    "请输入验证码",
)


class BlockedArticle(Exception):
    """The source is not an article body and must not be archived."""


def safe_name(value: str, fallback: str = "wechat-article") -> str:
    value = html.unescape(value or "").strip()
    value = re.sub(r"[\\/:*?\"<>|\x00-\x1f]+", "-", value)
    value = re.sub(r"\s+", " ", value).strip(" .-_")
    return value[:96] or fallback


def request(url: str, *, referer: str = "", binary: bool = False) -> tuple[str, bytes]:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        ),
        "Accept": "*/*" if binary else "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.7",
    }
    if referer:
        headers["Referer"] = referer
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
        return response.geturl(), response.read()


def decode(body: bytes) -> str:
    for encoding in ("utf-8", "gb18030", "gbk"):
        try:
            return body.decode(encoding)
        except UnicodeDecodeError:
            pass
    return body.decode("utf-8", errors="replace")


def text_only(value: str) -> str:
    value = re.sub(r"<br\s*/?>", "\n", value, flags=re.I)
    return html.unescape(re.sub(r"<[^>]+>", "", value)).strip()


def first_match(source: str, patterns: tuple[str, ...]) -> str:
    for pattern in patterns:
        match = re.search(pattern, source, flags=re.I | re.S)
        if match:
            return text_only(match.group(1))
    return ""


def metadata(source: str, source_url: str) -> dict[str, str]:
    published = first_match(source, (
        r"var\s+publish_time\s*=\s*['\"]([^'\"]+)",
        r"var\s+ct\s*=\s*['\"](\d+)",
    ))
    if published.isdigit():
        try:
            published = dt.datetime.fromtimestamp(int(published)).date().isoformat()
        except (OverflowError, OSError, ValueError):
            pass
    return {
        "title": first_match(source, (
            r"var\s+msg_title\s*=\s*['\"]([^'\"]*)",
            r"<meta\s+property=['\"]og:title['\"]\s+content=['\"]([^'\"]*)",
            r"<h1[^>]+id=['\"]activity-name['\"][^>]*>(.*?)</h1>",
            r"<title[^>]*>(.*?)</title>",
        )) or "WeChat Article",
        "account": first_match(source, (
            r"var\s+nickname\s*=\s*['\"]([^'\"]*)",
            r"id=['\"]js_name['\"][^>]*>\s*([^<]+)",
        )),
        "author": first_match(source, (r"var\s+author\s*=\s*['\"]([^'\"]*)",)),
        "published_at": published,
        "source": source_url,
        "captured_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
    }


class ArticleHtml(HTMLParser):
    """A conservative HTML→Markdown reader for the #js_content fragment."""

    VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.active = False
        self.out: list[str] = []
        self.images: list[tuple[str, str]] = []
        self.link: str | None = None
        self.pre = False
        self.list_depth = 0

    def emit(self, value: str) -> None:
        if self.active:
            self.out.append(value)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_map = dict(attrs)
        if not self.active and attrs_map.get("id") == "js_content":
            self.active, self.depth = True, 1
            return
        if not self.active:
            return
        void = tag in self.VOID_TAGS
        if not void:
            self.depth += 1
        if tag in ("p", "section", "div", "figure"):
            self.emit("\n\n")
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self.emit("\n\n" + "#" * int(tag[1]) + " ")
        elif tag == "br":
            self.emit("\n")
        elif tag in ("ul", "ol"):
            self.list_depth += 1
            self.emit("\n")
        elif tag == "li":
            self.emit("\n" + "  " * max(0, self.list_depth - 1) + "- ")
        elif tag == "blockquote":
            self.emit("\n\n> ")
        elif tag == "pre":
            self.pre = True
            self.emit("\n\n```\n")
        elif tag == "code" and not self.pre:
            self.emit("`")
        elif tag == "a":
            self.link = attrs_map.get("href") or ""
        elif tag == "img":
            src = attrs_map.get("data-src") or attrs_map.get("src") or ""
            if src and not src.startswith("data:"):
                token = f"__WE_READ_IMAGE_{len(self.images)}__"
                self.images.append((token, html.unescape(src)))
                self.emit("\n\n" + token + "\n\n")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID_TAGS:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        if not self.active:
            return
        if tag == "a" and self.link is not None:
            self.emit(f"]({self.link})")
            self.link = None
        elif tag == "code" and not self.pre:
            self.emit("`")
        elif tag == "pre":
            self.pre = False
            self.emit("\n```\n")
        elif tag in ("ul", "ol"):
            self.list_depth = max(0, self.list_depth - 1)
        self.depth -= 1
        if self.depth <= 0:
            self.active = False

    def handle_data(self, data: str) -> None:
        if not self.active:
            return
        value = data if self.pre else re.sub(r"\s+", " ", data)
        if not value.strip() and not self.pre:
            return
        if self.link is not None:
            self.emit("[" + value)
        else:
            self.emit(value)

    def markdown(self) -> str:
        value = "".join(self.out)
        value = re.sub(r"[ \t]+\n", "\n", value)
        value = re.sub(r"\n{3,}", "\n\n", value)
        return value.strip() + "\n"


def local_images(markdown: str, images: list[tuple[str, str]], source_url: str, directory: Path) -> str:
    assets = directory / "assets"
    for index, (token, source) in enumerate(images, start=1):
        absolute = urllib.parse.urljoin(source_url, source)
        try:
            final_url, body = request(absolute, referer=source_url, binary=True)
            suffix = Path(urllib.parse.urlparse(final_url).path).suffix.lower()
            if not re.fullmatch(r"\.[a-z0-9]{1,6}", suffix):
                suffix = mimetypes.guess_extension("image/jpeg") or ".jpg"
            assets.mkdir(parents=True, exist_ok=True)
            target = assets / f"{index:03d}{suffix}"
            target.write_bytes(body)
            replacement = f"![图片 {index}](assets/{target.name})"
        except (OSError, urllib.error.URLError, ValueError):
            replacement = f"![图片 {index}]({absolute})"
        markdown = markdown.replace(token, replacement)
    return markdown


def yaml_value(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def convert(source: str, source_url: str, output_root: Path) -> Path:
    if any(marker in source for marker in CAPTCHA_MARKERS):
        raise BlockedArticle("微信要求验证；请在浏览器中完成验证后再重试。")
    meta = metadata(source, source_url)
    parser = ArticleHtml()
    parser.feed(source)
    body = parser.markdown()
    if not body or len(body) < 20:
        raise BlockedArticle("页面没有可归档的正文；不会把错误页保存为文章。")
    date = meta["published_at"][:10] if re.fullmatch(r"\d{4}-\d{2}-\d{2}.*", meta["published_at"]) else dt.date.today().isoformat()
    stem = f"{date} {safe_name(meta['title'])}"
    directory = output_root / stem
    directory.mkdir(parents=True, exist_ok=True)
    body = local_images(body, parser.images, source_url, directory)
    frontmatter = "\n".join(["---", *(f"{key}: {yaml_value(value)}" for key, value in meta.items()), "---", ""])
    markdown = directory / f"{stem}.md"
    markdown.write_text(frontmatter + "\n" + body, encoding="utf-8")
    (directory / "metadata.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return markdown


def main() -> int:
    parser = argparse.ArgumentParser(description="将一篇微信公众号文章保存为本地 Markdown 与图片")
    parser.add_argument("url", nargs="?", help="公众号文章 URL")
    parser.add_argument("--html-file", help="已在浏览器验证并保存的 HTML 文件")
    parser.add_argument("--source-url", help="配合 --html-file 提供原始文章 URL")
    parser.add_argument("--out-dir", required=True, help="输出根目录")
    args = parser.parse_args()
    if bool(args.url) == bool(args.html_file):
        parser.error("请提供一篇 URL，或同时提供 --html-file 与 --source-url")
    try:
        if args.html_file:
            source_url = args.source_url or ""
            if not source_url:
                parser.error("--html-file 需要配合 --source-url")
            source = Path(args.html_file).read_text(encoding="utf-8", errors="replace")
        else:
            source_url, body = request(args.url)
            source = decode(body)
        markdown = convert(source, source_url, Path(args.out_dir))
        print(json.dumps({"markdown": str(markdown), "metadata": str(markdown.parent / "metadata.json")}, ensure_ascii=False))
        return 0
    except BlockedArticle as error:
        print(str(error), file=sys.stderr)
        return 3
    except (OSError, urllib.error.URLError, ValueError) as error:
        print(f"归档失败：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
