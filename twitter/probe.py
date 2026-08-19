#!/usr/bin/env python3
"""Low-volume, read-only Twitter/X connectivity probe."""

from __future__ import annotations

import argparse
import asyncio
import json
import re
from datetime import datetime, timezone

from compat import CompatibleGuestClient


SCREEN_NAME = re.compile(r"^[A-Za-z0-9_]{1,15}$")


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch one public X profile and a small recent-tweet sample."
    )
    parser.add_argument("screen_name", nargs="?", default="NASA")
    parser.add_argument("--count", type=int, default=5, choices=range(1, 21))
    return parser.parse_args()


async def probe(screen_name: str, count: int) -> dict:
    if not SCREEN_NAME.fullmatch(screen_name):
        raise ValueError("screen_name must be 1-15 letters, digits, or underscores")

    client = CompatibleGuestClient(language="en-US", timeout=20)
    try:
        await client.activate()
        user = await client.get_user_by_screen_name(screen_name)
        tweets = await client.get_user_tweets(user.id, "Tweets", count=count)
        return {
            "ok": True,
            "mode": "guest",
            "retrievedAt": datetime.now(timezone.utc).isoformat(),
            "profile": {
                "id": user.id,
                "screenName": user.screen_name,
                "name": user.name,
                "description": user.description,
                "followersCount": user.followers_count,
            },
            "tweets": [
                {
                    "id": tweet.id,
                    "url": f"https://x.com/{user.screen_name}/status/{tweet.id}",
                    "createdAt": tweet.created_at,
                    "text": tweet.full_text,
                    "replyCount": tweet.reply_count,
                    "retweetCount": tweet.retweet_count,
                    "favoriteCount": tweet.favorite_count,
                }
                for tweet in tweets[:count]
            ],
        }
    finally:
        await client.http.aclose()


async def main() -> None:
    args = arguments()
    result = await probe(args.screen_name.lstrip("@"), args.count)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
