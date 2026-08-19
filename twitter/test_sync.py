import importlib.util
import os
import sys
import tempfile
import unittest
import json
from pathlib import Path
from unittest import mock


TWITTER_DIR = Path(__file__).parent
sys.path.insert(0, str(TWITTER_DIR))
SPEC = importlib.util.spec_from_file_location("twitter_sync", TWITTER_DIR / "sync.py")
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)


class TwitterSyncTests(unittest.TestCase):
    def test_normalize_screen_name(self):
        self.assertEqual(sync.normalize_screen_name("@karpathy"), "karpathy")
        self.assertEqual(sync.normalize_screen_name("https://x.com/JeffDean"), "JeffDean")
        with self.assertRaises(ValueError):
            sync.normalize_screen_name("https://example.com/karpathy")

    def test_snowflake_time(self):
        value = sync.snowflake_timestamp("1617979122625712128")
        self.assertGreater(value, 1_600_000_000)
        self.assertLess(value, 1_800_000_000)

    def test_merge_source_preserves_other_platforms(self):
        library = {"sources": [{"bookId": "MP_WXS_1", "name": "keep", "items": []}]}
        account = {"sourceId": "TW_USER_1", "name": "A", "screenName": "a", "url": "https://x.com/a"}
        tweet = {"rid": "TW_TWEET_2", "t": 2, "title": "hello", "text": "hello", "url": "https://x.com/a/status/2"}
        sync.merge_source(library, account, [tweet])
        self.assertEqual([source["bookId"] for source in library["sources"]], ["MP_WXS_1", "TW_USER_1"])
        self.assertEqual(library["sources"][1]["platform"], "twitter")

    def test_archive_tweet(self):
        with tempfile.TemporaryDirectory() as root:
            account = {"sourceId": "TW_USER_1", "name": "A", "screenName": "a"}
            tweet = {"rid": "TW_TWEET_2", "tweetId": "2", "t": 1_700_000_000, "title": "hello", "text": "hello world", "translation": "你好，世界", "url": "https://x.com/a/status/2", "createdAt": "", "replyCount": 1, "retweetCount": 2, "favoriteCount": 3}
            result = sync.archive_tweet(Path(root), account, tweet)
            text = (Path(root) / result["markdown"]).read_text(encoding="utf-8")
            self.assertIn("hello world", text)
            self.assertIn("## 中文翻译", text)
            self.assertIn("你好，世界", text)
            self.assertIn("## 英文原文", text)
            self.assertIn("在 X 上查看原帖", text)

    def test_translation_chunks_preserve_text(self):
        value = "first sentence. " * 120
        chunks = sync.translation_chunks(value, limit=120)
        self.assertGreater(len(chunks), 1)
        self.assertEqual("".join(chunks).replace(" ", ""), value.strip().replace(" ", ""))

    def test_long_tweet_word_count_and_archive_presentation(self):
        self.assertEqual(sync.english_word_count("AI-native systems don't stop."), 4)
        with tempfile.TemporaryDirectory() as root:
            account = {"sourceId": "TW_USER_1", "name": "A", "screenName": "a"}
            tweet = {
                "rid": "TW_TWEET_3", "tweetId": "3", "t": 1_700_000_000,
                "title": "long original", "text": "word " * 501, "wordCount": 501,
                "translation": "完整中文译文", "displayTitle": "长推文中文标题", "abstract": "长推文中文摘要",
                "presentationProvider": sync.PRESENTATION_PROVIDER,
                "url": "https://x.com/a/status/3", "createdAt": "", "replyCount": 0,
                "retweetCount": 0, "favoriteCount": 0,
            }
            result = sync.archive_tweet(Path(root), account, tweet)
            text = (Path(root) / result["markdown"]).read_text(encoding="utf-8")
            self.assertIn("# 长推文中文标题", text)
            self.assertIn("## 中文摘要", text)
            self.assertIn("长推文中文摘要", text)
            self.assertIn("## 中文翻译", text)

    def test_codex_environment_includes_local_node_directory(self):
        environment = sync.codex_environment(str(Path.home() / ".local" / "bin" / "codex"))
        paths = environment["PATH"].split(os.pathsep)
        self.assertIn(str(Path.home() / ".local" / "bin"), paths[:2])

    def test_authenticated_cookie_map_requires_auth_and_csrf(self):
        with tempfile.TemporaryDirectory() as root:
            cookie_file = Path(root) / "cookies.json"
            cookie_file.write_text(json.dumps({"auth_token": "private"}), encoding="utf-8")
            self.assertIsNone(sync.authenticated_cookie_map(cookie_file))
            cookie_file.write_text(
                json.dumps({"auth_token": "private", "ct0": "csrf"}), encoding="utf-8"
            )
            self.assertEqual(
                sync.authenticated_cookie_map(cookie_file),
                {"auth_token": "private", "ct0": "csrf"},
            )

    def test_apply_value_decision_records_auditable_gate_metadata(self):
        tweet = {"rid": "TW_TWEET_9", "text": "specific analysis"}
        sync.apply_value_decision(tweet, {
            "decision": "keep", "reason": "包含具体机制分析", "valueSignals": ["机制"],
            "caveat": "", "confidence": 0.91,
        })
        self.assertEqual(tweet["valueDecision"], "keep")
        self.assertEqual(tweet["valueFilterProvider"], "gpt-5.6-terra/medium")
        self.assertEqual(tweet["valueFilterVersion"], sync.VALUE_FILTER_VERSION)
        self.assertEqual(tweet["valueSignals"], ["机制"])

    def test_backfill_value_gate_removes_drop_from_feed_but_quarantines_archive(self):
        with tempfile.TemporaryDirectory() as root:
            data = Path(root)
            paths = sync.paths(data)
            library = {"sources": [{
                "bookId": "TW_USER_1", "name": "A", "screenName": "a", "platform": "twitter",
                "items": [
                    {"rid": "TW_TWEET_1", "title": "Grok @Bot", "text": "Grok @Bot", "url": "https://x.com/a/status/1", "t": 2},
                    {"rid": "TW_TWEET_2", "title": "analysis", "text": "Company revenue grew 20% because pricing changed.", "url": "https://x.com/a/status/2", "t": 1},
                ],
            }]}
            status = {"archived": {"TW_TWEET_1": {"markdown": "文章/Twitter/a/1.md"}}, "failures": {}, "deleted": {}}
            sync.write_json(paths["library"], library)
            sync.write_json(paths["status"], status)
            decisions = {
                "TW_TWEET_1": {"id": "TW_TWEET_1", "decision": "drop", "reason": "只有产品名", "valueSignals": [], "caveat": "", "confidence": .99},
                "TW_TWEET_2": {"id": "TW_TWEET_2", "decision": "keep", "reason": "含事实与因果", "valueSignals": ["收入增长", "定价原因"], "caveat": "", "confidence": .95},
            }
            with mock.patch.object(sync, "classify_value_queue", return_value=decisions):
                result = sync.backfill_value_gate(data)
            updated_library = sync.read_json(paths["library"], {})
            updated_status = sync.read_json(paths["status"], {})
            items = updated_library["sources"][0]["items"]
            self.assertEqual([item["rid"] for item in items], ["TW_TWEET_2"])
            self.assertEqual(items[0]["valueDecision"], "keep")
            self.assertNotIn("TW_TWEET_1", updated_status["archived"])
            self.assertIn("quarantinedArchive", updated_status["filtered"]["TW_TWEET_1"])
            self.assertEqual(result["filtered"], 1)

    def test_sync_filters_before_translation_and_library_merge(self):
        with tempfile.TemporaryDirectory() as root:
            data = Path(root)
            paths = sync.paths(data)
            account = {"sourceId": "TW_USER_1", "userId": "1", "name": "A", "screenName": "a", "description": "", "followersCount": 0, "url": "https://x.com/a", "enabled": True}
            sync.write_json(paths["subscriptions"], {"accounts": [account], "settings": {}})
            sync.write_json(paths["library"], {"sources": []})
            sync.write_json(paths["status"], {"archived": {}, "failures": {}, "deleted": {}})
            keep = {"rid": "TW_TWEET_2", "tweetId": "2", "t": 2, "title": "analysis", "text": "Revenue grew 20% because pricing changed.", "url": "https://x.com/a/status/2", "createdAt": "", "replyCount": 0, "retweetCount": 0, "favoriteCount": 0}
            drop = {"rid": "TW_TWEET_1", "tweetId": "1", "t": 1, "title": "Grok @Bot", "text": "Grok @Bot", "url": "https://x.com/a/status/1", "createdAt": "", "replyCount": 0, "retweetCount": 0, "favoriteCount": 0}
            decisions = {
                keep["rid"]: {"id": keep["rid"], "decision": "keep", "reason": "含事实与因果", "valueSignals": ["收入增长"], "caveat": "", "confidence": .95},
                drop["rid"]: {"id": drop["rid"], "decision": "drop", "reason": "只有产品名", "valueSignals": [], "caveat": "", "confidence": .99},
            }
            with (
                mock.patch.object(sync, "fetch_public_account_with_retry", return_value=(account, [keep, drop])),
                mock.patch.object(sync, "classify_value_queue", return_value=decisions),
                mock.patch.object(sync, "translate_queue", return_value=({keep["rid"]: "收入因定价改变而增长 20%。"}, {keep["rid"]: sync.TERRA_PROVIDER})) as translator,
                mock.patch.object(sync, "archive_tweet", return_value={"markdown": "文章/Twitter/a/2.md", "translatedAt": sync.now_iso()}),
            ):
                result = sync.sync(data, None, 2, 0)
            translated_tweets = translator.call_args.args[0]
            self.assertEqual([item["rid"] for item in translated_tweets], [keep["rid"]])
            updated_library = sync.read_json(paths["library"], {})
            items = updated_library["sources"][0]["items"]
            self.assertEqual([item["rid"] for item in items], [keep["rid"]])
            self.assertEqual(items[0]["valueDecision"], "keep")
            updated_status = sync.read_json(paths["status"], {})
            self.assertIn(drop["rid"], updated_status["filtered"])
            self.assertEqual(result["filtered"], 1)


if __name__ == "__main__":
    unittest.main()
