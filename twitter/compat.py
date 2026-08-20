"""Small compatibility layer for reading public X data with Twikit 2.3.3.

X's logged-out frontend changed after Twikit 2.3.3 was released. Guest token
activation still works without an x-client-transaction-id, while Twikit's old
transaction bootstrap now fails before sending the request. X also omits some
empty fields that Twikit's guest models currently treat as mandatory.

Keep these workarounds local so the installed third-party package remains
untouched and can be replaced cleanly when upstream catches up.
"""

from __future__ import annotations

import json
from typing import Any

from twikit import Client
from twikit.constants import TOKEN
from twikit.errors import (
    BadRequest,
    Forbidden,
    NotFound,
    RequestTimeout,
    ServerError,
    TooManyRequests,
    TwitterException,
    Unauthorized,
)
from twikit.guest import GuestClient


USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6_1) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/138.0.0.0 Safari/537.36"
)

_USER_DEFAULTS: dict[str, Any] = {
    "created_at": "",
    "name": "",
    "screen_name": "",
    "profile_image_url_https": "",
    "location": "",
    "description": "",
    "verified": False,
    "possibly_sensitive": False,
    "default_profile": False,
    "default_profile_image": False,
    "has_custom_timelines": False,
    "followers_count": 0,
    "fast_followers_count": 0,
    "normal_followers_count": 0,
    "friends_count": 0,
    "favourites_count": 0,
    "listed_count": 0,
    "media_count": 0,
    "statuses_count": 0,
    "is_translator": False,
    "translator_type": "none",
}

_TWEET_DEFAULTS: dict[str, Any] = {
    "created_at": "",
    "full_text": "",
    "lang": "und",
    "is_quote_status": False,
    "quote_count": 0,
    "reply_count": 0,
    "favorite_count": 0,
    "favorited": False,
    "retweet_count": 0,
}


def _normalize_response(node: Any) -> Any:
    """Supply only fields that X now omits when they are empty."""
    if isinstance(node, list):
        for item in node:
            _normalize_response(item)
        return node

    if not isinstance(node, dict):
        return node

    legacy = node.get("legacy")
    if isinstance(legacy, dict) and "screen_name" in legacy:
        for key, default in _USER_DEFAULTS.items():
            legacy.setdefault(key, default)
        legacy.setdefault("pinned_tweet_ids_str", [])
        legacy.setdefault("withheld_in_countries", [])
        entities = legacy.setdefault("entities", {})
        entities.setdefault("description", {}).setdefault("urls", [])
        entities.setdefault("url", {}).setdefault("urls", [])
        node.setdefault("is_blue_verified", False)

    if isinstance(legacy, dict) and "full_text" in legacy:
        for key, default in _TWEET_DEFAULTS.items():
            legacy.setdefault(key, default)
        entities = legacy.setdefault("entities", {})
        entities.setdefault("urls", [])
        entities.setdefault("hashtags", [])
        entities.setdefault("media", [])
        node.setdefault("edit_control", {})

    for value in node.values():
        _normalize_response(value)
    return node


def _raise_for_x_response(status_code: int, body: str, headers: Any) -> None:
    message = f'status: {status_code}, message: "{body[:1000]}"'
    error_type = {
        400: BadRequest,
        401: Unauthorized,
        403: Forbidden,
        404: NotFound,
        408: RequestTimeout,
        429: TooManyRequests,
    }.get(status_code)
    if error_type is None and 500 <= status_code < 600:
        error_type = ServerError
    raise (error_type or TwitterException)(message, headers=headers)


class CompatibleGuestClient(GuestClient):
    """Twikit GuestClient with narrow August 2026 read-only compatibility."""

    async def activate(self) -> str:
        headers = {
            "authorization": f"Bearer {TOKEN}",
            "user-agent": USER_AGENT,
            "content-type": "application/x-www-form-urlencoded",
            "accept": "*/*",
            "origin": "https://x.com",
            "referer": "https://x.com/",
        }
        response = await self.http.post(
            "https://api.x.com/1.1/guest/activate.json",
            headers=headers,
            data={},
        )
        if response.status_code >= 400:
            _raise_for_x_response(response.status_code, response.text, response.headers)
        self._guest_token = response.json()["guest_token"]
        return self._guest_token

    async def request(
        self,
        method: str,
        url: str,
        raise_exception: bool = True,
        **kwargs: Any,
    ) -> tuple[dict | Any, Any]:
        """Send the request without Twikit's currently broken TID bootstrap."""
        headers = kwargs.pop("headers", {})
        headers.setdefault("user-agent", USER_AGENT)
        response = await self.http.request(method, url, headers=headers, **kwargs)
        try:
            response_data = response.json()
        except json.JSONDecodeError:
            response_data = response.text

        if response.status_code >= 400 and raise_exception:
            _raise_for_x_response(response.status_code, response.text, response.headers)
        if isinstance(response_data, (dict, list)):
            _normalize_response(response_data)
        return response_data, response


class CompatibleAuthenticatedClient(Client):
    """Authenticated, read-only Client without Twikit's stale TID bootstrap."""

    async def request(
        self,
        method: str,
        url: str,
        raise_exception: bool = True,
        **kwargs: Any,
    ) -> tuple[dict | Any, Any]:
        headers = kwargs.pop("headers", {})
        headers.setdefault("user-agent", USER_AGENT)
        response = await self.http.request(method, url, headers=headers, **kwargs)
        self._remove_duplicate_ct0_cookie()
        try:
            response_data = response.json()
        except json.JSONDecodeError:
            response_data = response.text

        if response.status_code >= 400 and raise_exception:
            _raise_for_x_response(response.status_code, response.text, response.headers)
        if isinstance(response_data, (dict, list)):
            _normalize_response(response_data)
        return response_data, response
