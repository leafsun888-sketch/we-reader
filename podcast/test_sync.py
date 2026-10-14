import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import sync


class PodcastSyncTests(unittest.TestCase):
    def test_normalize_xiaoyuzhou_urls(self):
        self.assertEqual(
            sync.normalize_url("https://www.xiaoyuzhoufm.com/podcast/633120182a992d56e91e503b"),
            "https://www.xiaoyuzhoufm.com/podcast/633120182a992d56e91e503b",
        )
        with self.assertRaises(ValueError):
            sync.normalize_url("https://example.com/podcast/1")

    def test_resolve_episode_finds_its_podcast(self):
        episode = {"episode": {"podcast": {"pid": "p1", "title": "Demo"}}}
        podcast = {"podcast": {"pid": "p1", "title": "Demo", "author": "A", "episodes": [{"eid": "e1"}]}}
        with patch.object(sync, "next_data", side_effect=[episode, podcast]):
            result = sync.resolve_podcast("https://www.xiaoyuzhoufm.com/episode/e1")
        self.assertEqual(result["sourceId"], "XYZ_PODCAST_p1")
        self.assertEqual(result["name"], "Demo")

    def test_discover_reads_public_audio(self):
        resolved = {
            "episodes": [{
                "eid": "e1", "title": "Episode", "description": "Notes",
                "enclosure": {"url": "https://media.xyzcdn.net/e1.m4a"},
                "duration": 10, "pubDate": "2026-08-21T00:00:00Z",
            }]
        }
        with patch.object(sync, "resolve_podcast", return_value=resolved):
            episodes = sync.discover({"url": "https://www.xiaoyuzhoufm.com/podcast/p1"})
        self.assertEqual(episodes[0]["rid"], "XYZ_EPISODE_e1")
        self.assertEqual(episodes[0]["audioUrl"], "https://media.xyzcdn.net/e1.m4a")

    def test_subscribe_and_merge_are_local(self):
        podcast = {
            "podcastId": "p1", "sourceId": "XYZ_PODCAST_p1", "name": "Demo",
            "author": "A", "description": "D", "url": "https://www.xiaoyuzhoufm.com/podcast/p1",
            "episodes": [],
        }
        with tempfile.TemporaryDirectory() as directory, patch.object(sync, "resolve_podcast", return_value=podcast):
            root = Path(directory)
            record = sync.subscribe(root, podcast["url"], 3)
            config = sync.read_json(sync.paths(root)["subscriptions"], {})
            self.assertEqual(record["initialEpisodeLimit"], 3)
            self.assertEqual(config["podcasts"][0]["sourceId"], "XYZ_PODCAST_p1")

    def test_coalesce_segments_preserves_order(self):
        segments = [
            {"start": 0, "text": "第一句。"},
            {"start": 3, "text": "第二句。"},
            {"start": 8, "text": "第三句很长。"},
        ]
        units = sync.coalesce_segments(segments, target_chars=9)
        self.assertEqual([item["id"] for item in units], ["s0001", "s0002"])
        self.assertEqual(units[0]["start"], 0)
        self.assertEqual(units[1]["start"], 8)
        self.assertEqual(" ".join(item["text"] for item in units), "第一句。 第二句。 第三句很长。")

    def test_legacy_segments_and_manuscript_lines(self):
        raw = "## 逐字稿\n\n**[01:05]** 第一段\n\n**[62:03]** 第二段\n"
        segments = sync.legacy_segments(raw)
        self.assertEqual(segments, [{"start": 65, "text": "第一段"}, {"start": 3723, "text": "第二段"}])
        lines = sync.manuscript_lines([{"start": 3723, "text": "整理后的自然段。"}])
        self.assertEqual(lines[0], "**[01:02:03]** 整理后的自然段。")


if __name__ == "__main__":
    unittest.main()
