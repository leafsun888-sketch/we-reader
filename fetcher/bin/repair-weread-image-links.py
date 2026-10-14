#!/usr/bin/env python3
"""Repair already-downloaded assets from the new route; no network requests."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--write', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2] / 'data'
    spec = importlib.util.spec_from_file_location(
        'readgzh', Path(__file__).resolve().parents[1] / 'vendor/readgzh.py')
    converter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(converter)
    status = json.loads((root / '数据/archive-status.json').read_text())
    changed = links = incomplete = 0
    for key, entry in status['archived'].items():
        if entry.get('method') != 'weread-content':
            continue
        markdown = root / entry['markdown']
        if not markdown.is_file():
            continue
        prefix = hashlib.sha256(key.encode()).hexdigest()[:10]
        snapshots = list((root / '.incoming').glob(f'{prefix}-*/article.html'))
        if not snapshots:
            continue
        snapshot = max(snapshots, key=lambda p: p.stat().st_mtime)
        html = snapshot.read_text(encoding='utf-8')
        reader = converter.ArticleHtml()
        reader.feed(html)
        urls = [url for _, url in reader.images]
        assets = markdown.parent / 'assets'
        text = markdown.read_text(encoding='utf-8')
        before = text
        if 'js_share_source' in html and '阅读全文' in text and not entry.get('incomplete'):
            entry['incomplete'] = True
            incomplete += 1
        unique_urls = list(dict.fromkeys(urls))
        for index, url in enumerate(urls, 1):
            legacy_index = unique_urls.index(url) + 1
            matches = list(assets.glob(f'{index:03d}.*')) or list(assets.glob(f'image-{legacy_index:02d}.*'))
            if len(matches) == 1 and url in text:
                links += text.count(url)
                text = text.replace(url, f'assets/{matches[0].name}')
        if text != before:
            changed += 1
            if args.write:
                temp = markdown.with_suffix(f'.tmp-{os.getpid()}')
                temp.write_text(text, encoding='utf-8')
                temp.replace(markdown)
    if args.write and incomplete:
        target = root / '数据/archive-status.json'
        temp = target.with_suffix(f'.tmp-{os.getpid()}')
        temp.write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding='utf-8')
        temp.replace(target)
    print(json.dumps({'articles': changed, 'links': links, 'incompleteCards': incomplete, 'written': args.write}))


if __name__ == '__main__':
    main()
