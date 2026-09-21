"""Pure logic for the PharmaITChat switch buttons: parse a tap, check who tapped, ask the app, pick the reply.
No Telegram or Hermes imports, so it tests with the standard library alone."""

from __future__ import annotations

import http.client
import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable, Mapping, Optional

PATTERN = r"^pls:(ok|no):[0-9a-f]{32}$"
_TAP = re.compile(PATTERN)


@dataclass(frozen=True)
class Tap:
    action: str  # "confirm" or "cancel", the app route it calls
    token: str


@dataclass(frozen=True)
class AppReply:
    status: int  # 0 when the app could not be reached
    body: dict
    error: str = ""  # exception class name only: a message could echo the request


@dataclass(frozen=True)
class Outcome:
    toast: str
    text: Optional[str]  # replaces the message and drops its buttons; None keeps both for a retry


def parse_tap(data: Optional[str]) -> Optional[Tap]:
    if not data or not _TAP.match(data):
        return None
    _, choice, token = data.split(":")
    return Tap("confirm" if choice == "ok" else "cancel", token)


def is_allowed(user_id: object, env: Mapping[str, str]) -> bool:
    allowed = {part.strip() for part in env.get("TELEGRAM_ALLOWED_USERS", "").split(",") if part.strip()}
    return user_id is not None and str(user_id) in allowed


def env_with_fallback(env: Mapping[str, str], suffix: str) -> str:
    """Mirrors src/config/env-names.ts:readEnvWithFallback -- prefers PHARMAITCHAT_<suffix>, falls
    back to the legacy PHARMALLM_<suffix>, trims both and treats blank as absent. Kept in sync by
    hand (no shared module between TypeScript and this plugin); used for the API token so a token
    rotation that only refreshes the new key in ~/.hermes/.env cannot leave this plugin sending a
    stale one to /api/stack/confirm|cancel."""
    preferred = env.get(f"PHARMAITCHAT_{suffix}", "").strip()
    if preferred:
        return preferred
    return env.get(f"PHARMALLM_{suffix}", "").strip()


def _json(raw: bytes) -> dict:
    try:
        value = json.loads(raw.decode("utf-8") or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def post_json(url: str, body: dict, token: str, timeout: float = 10.0) -> AppReply:
    try:
        # Request(...) itself can raise (e.g. ValueError on a malformed PHARMALLM_URL), so it stays
        # inside the try: every failure path must return an AppReply, never raise.
        request = urllib.request.Request(
            url, data=json.dumps(body).encode("utf-8"), method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return AppReply(response.status, _json(response.read()))
    except urllib.error.HTTPError as err:
        with err:
            # Reading the body can fail too (e.g. IncompleteRead): the status alone is still the answer
            try:
                body = _json(err.read())
            except (OSError, http.client.HTTPException):
                body = {}
            return AppReply(err.code, body)
    except (urllib.error.URLError, OSError, http.client.HTTPException, ValueError) as err:
        # Class name only: a message could echo the URL or the request body.
        return AppReply(0, {}, type(err).__name__)


def outcome_for(tap: Tap, reply: AppReply) -> Outcome:
    if reply.status == 200 and tap.action == "confirm":
        target = str(reply.body.get("target") or "the new stack")
        return Outcome(f"✅ Switching to {target}", f"✅ Switching to {target} — PharmaITChat restarts in a moment")
    if reply.status == 200:
        return Outcome("✖ Switch cancelled", "✖ Switch cancelled")
    if reply.status == 410:
        return Outcome("⌛ Expired", "⌛ Expired — request the switch again from PharmaITChat")
    detail = reply.error or f"HTTP {reply.status}"
    return Outcome(f"⚠️ Could not reach PharmaITChat ({detail})", None)


def resolve(tap: Tap, env: Mapping[str, str],
            post: Callable[[str, dict, str], AppReply] = post_json) -> Outcome:
    base = env.get("PHARMALLM_URL", "http://localhost:3000").rstrip("/")
    reply = post(f"{base}/api/stack/{tap.action}", {"token": tap.token}, env_with_fallback(env, "API_TOKEN"))
    return outcome_for(tap, reply)
