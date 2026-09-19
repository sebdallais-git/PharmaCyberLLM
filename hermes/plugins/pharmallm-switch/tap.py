"""Pure logic for the PharmaLLM switch buttons: parse a tap, check who tapped, ask the app, pick the reply.
No Telegram or Hermes imports, so it tests with the standard library alone."""

from __future__ import annotations

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


def _json(raw: bytes) -> dict:
    try:
        value = json.loads(raw.decode("utf-8") or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def post_json(url: str, body: dict, token: str, timeout: float = 10.0) -> AppReply:
    request = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"), method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return AppReply(response.status, _json(response.read()))
    except urllib.error.HTTPError as err:
        return AppReply(err.code, _json(err.read()))
    except (urllib.error.URLError, OSError) as err:
        return AppReply(0, {}, type(err).__name__)


def outcome_for(tap: Tap, reply: AppReply) -> Outcome:
    if reply.status == 200 and tap.action == "confirm":
        target = str(reply.body.get("target") or "the new stack")
        return Outcome(f"✅ Switching to {target}", f"✅ Switching to {target} — PharmaLLM restarts in a moment")
    if reply.status == 200:
        return Outcome("✖ Switch cancelled", "✖ Switch cancelled")
    if reply.status == 410:
        return Outcome("⌛ Expired", "⌛ Expired — request the switch again from PharmaLLM")
    detail = reply.error or f"HTTP {reply.status}"
    return Outcome(f"⚠️ Could not reach PharmaLLM ({detail})", None)


def resolve(tap: Tap, env: Mapping[str, str],
            post: Callable[[str, dict, str], AppReply] = post_json) -> Outcome:
    base = env.get("PHARMALLM_URL", "http://localhost:3000").rstrip("/")
    reply = post(f"{base}/api/stack/{tap.action}", {"token": tap.token}, env.get("PHARMALLM_API_TOKEN", ""))
    return outcome_for(tap, reply)
