import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import sync


class Snippet:
    def __init__(self, text, start):
        self.text = text
        self.start = start


class YoutubeSyncTests(unittest.TestCase):
    def test_youtube_url_validation(self):
        self.assertEqual(
            sync.validate_youtube_url("https://www.youtube.com/@OpenAI"),
            "https://www.youtube.com/@OpenAI",
        )
        with self.assertRaises(ValueError):
            sync.validate_youtube_url("https://example.com/@OpenAI")

    def test_merge_source_preserves_other_platforms(self):
        library = {
            "sources": [{"name": "公众号", "bookId": "MP_WXS_1", "items": []}]
        }
        channel = {
            "name": "Demo",
            "channelId": "UC1234567890123456789012",
            "sourceId": "YT_CHANNEL_UC1234567890123456789012",
            "url": "https://www.youtube.com/channel/UC1234567890123456789012",
        }
        video = {
            "rid": "YT_VIDEO_abcdefghijk",
            "videoId": "abcdefghijk",
            "title": "Demo video",
            "url": "https://www.youtube.com/watch?v=abcdefghijk",
            "t": 10,
        }
        sync.merge_source(library, channel, [video])
        self.assertEqual(len(library["sources"]), 2)
        source = library["sources"][1]
        self.assertEqual(source["platform"], "youtube")
        self.assertEqual(source["items"][0]["rid"], video["rid"])

    def test_json_write_is_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "nested" / "value.json"
            sync.write_json(path, {"hello": "世界"})
            self.assertEqual(sync.read_json(path, {}), {"hello": "世界"})

    def test_transcript_markdown_is_chinese_then_english(self):
        channel = {
            "name": "Demo", "channelId": "UC1234567890123456789012",
            "url": "https://www.youtube.com/@demo",
        }
        video = {
            "title": "Original title", "videoId": "abcdefghijk",
            "url": "https://www.youtube.com/watch?v=abcdefghijk",
            "publishedAt": "2026-08-18T00:00:00Z",
        }
        segments = [{"id": "segment-0", "start": 12, "text": "English source."}]
        markdown = sync.transcript_markdown(
            channel, video, segments,
            {"title": "中文标题", "segment-0": "中文译文。"},
            "en", True, sync.TERRA_PROVIDER,
        )
        self.assertLess(markdown.index("## 中文译文"), markdown.index("## English Transcript"))
        self.assertIn("[00:12](https://www.youtube.com/watch?v=abcdefghijk&t=12s) 中文译文。", markdown)
        self.assertIn("English source.", markdown)

    def test_caption_snippets_are_coalesced_without_losing_text(self):
        fetched = [Snippet("First sentence.", 1.2), Snippet("Second sentence.", 4.8), Snippet("Third.", 9.1)]
        segments = sync.coalesce_transcript_snippets(fetched, target_chars=31)
        self.assertEqual([segment["text"] for segment in segments], ["First sentence.", "Second sentence. Third."])
        self.assertEqual([segment["start"] for segment in segments], [1, 4])
        self.assertEqual(" ".join(segment["text"] for segment in segments), "First sentence. Second sentence. Third.")

    def test_readable_paragraphs_split_speaker_turns_and_long_prose(self):
        value = "Host starts here. >> Guest answers this question. " + ("Long sentence. " * 60)
        paragraphs = sync.readable_paragraphs(value, limit=120)
        self.assertEqual(paragraphs[0], "Host starts here.")
        self.assertTrue(paragraphs[1].startswith("Guest answers"))
        self.assertTrue(all(len(paragraph) <= 120 for paragraph in paragraphs))

    def test_reflow_markdown_marks_and_splits_transcript(self):
        markdown = """---
translation_provider: \"terra\"
---
## 中文译文

[00:00](https://youtube.test/watch?v=1&t=0s) 第一句。第二句。第三句很长很长很长很长很长。

## English Transcript

[00:00](https://youtube.test/watch?v=1&t=0s) First. Second. Third sentence is deliberately long.
"""
        formatted = sync.reflow_markdown_text(markdown)
        self.assertIn('transcript_format: "readable-v3"', formatted)
        self.assertEqual(formatted, sync.reflow_markdown_text(formatted))

    def test_google_fallback_chunks_preserve_long_text(self):
        value = "A complete sentence. " * 200
        chunks = sync.translation_chunks(value, limit=120)
        self.assertGreater(len(chunks), 1)
        self.assertEqual("".join(chunks).replace(" ", ""), value.strip().replace(" ", ""))

    def test_partial_terra_result_retries_only_missing_entries(self):
        entries = [
            {"id": "one", "text": "First"},
            {"id": "two", "text": "Second"},
        ]
        with patch.object(sync, "translate_with_terra", side_effect=[{"one": "第一"}, {"two": "第二"}]) as terra:
            translations, providers = sync.translate_entries(entries)
        self.assertEqual(translations, {"one": "第一", "two": "第二"})
        self.assertEqual(set(providers.values()), {sync.TERRA_PROVIDER})
        self.assertEqual(terra.call_count, 2)

    def test_interrupted_initial_sync_does_not_append_another_batch(self):
        channel = {
            "name": "Demo", "channelId": "UC1234567890123456789012",
            "sourceId": "YT_CHANNEL_UC1234567890123456789012",
            "url": "https://www.youtube.com/@demo", "enabled": True,
            "initialVideoLimit": 5,
        }
        videos = [{
            "rid": f"YT_VIDEO_demo{i:07d}", "videoId": f"demo{i:07d}",
            "title": f"Video {i}", "url": f"https://www.youtube.com/watch?v=demo{i:07d}",
            "t": 100 - i, "publishedAt": "2026-08-18T00:00:00Z",
        } for i in range(15)]
        with tempfile.TemporaryDirectory() as directory:
            data_root = Path(directory)
            sync.write_json(data_root / "数据" / "youtube-subscriptions.json", {"channels": [channel]})
            sync.write_json(data_root / "数据" / "library.json", {
                "sources": [{"name": "Demo", "bookId": channel["sourceId"], "platform": "youtube", "items": videos}],
            })
            sync.write_json(data_root / "数据" / "youtube-status.json", {"archived": {}, "failures": {}})

            def archive(_root, current_channel, video):
                return {
                    "sourceId": current_channel["sourceId"], "title": "中文 " + video["title"],
                    "originalTitle": video["title"], "url": video["url"],
                    "markdown": "文章/YouTube/demo.md", "translationProvider": sync.TERRA_PROVIDER,
                }

            with patch.object(sync, "discover", return_value=videos), patch.object(sync, "archive_transcript", side_effect=archive):
                result = sync.sync(data_root, None, max_new=10, delay=0)
            stored = sync.read_json(data_root / "数据" / "library.json", {})["sources"][0]
            self.assertEqual(result["queued"], 5)
            self.assertEqual(result["archived"], 5)
            self.assertEqual(len(stored["items"]), 5)

    def test_newer_discoveries_do_not_backfill_older_history(self):
        existing = [
            {"rid": "YT_VIDEO_existing1", "t": 200},
            {"rid": "YT_VIDEO_existing2", "t": 100},
        ]
        discovered = [
            {"rid": "YT_VIDEO_newer0001", "t": 300},
            {"rid": "YT_VIDEO_existing1", "t": 200},
            {"rid": "YT_VIDEO_older0001", "t": 50},
        ]
        self.assertEqual(
            [item["rid"] for item in sync.newer_discoveries(discovered, existing, 10)],
            ["YT_VIDEO_newer0001"],
        )

    def test_archive_path_is_relocated_to_real_published_date(self):
        with tempfile.TemporaryDirectory() as directory:
            data_root = Path(directory)
            old_dir = data_root / "文章" / "YouTube" / "Demo" / "2026-08-18 A video"
            old_dir.mkdir(parents=True)
            old_markdown = old_dir / "2026-08-18 A video.md"
            old_markdown.write_text("content", encoding="utf-8")
            item = {"publishedAt": "2026-08-11T12:00:00+00:00"}
            archived = {"markdown": str(old_markdown.relative_to(data_root))}
            self.assertTrue(sync.relocate_archive_to_published_date(data_root, item, archived))
            target = data_root / archived["markdown"]
            self.assertEqual(target.name, "2026-08-11 A video.md")
            self.assertTrue(target.is_file())
            self.assertFalse(old_dir.exists())


if __name__ == "__main__":
    unittest.main()
