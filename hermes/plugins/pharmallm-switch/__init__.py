"""pharmallm-switch: confirms or cancels a PharmaLLM stack switch from the Telegram buttons the app sends.

The app shares Hermes' bot and Hermes' gateway is that bot's only getUpdates consumer, so a tap on the
app's buttons lands here. The handler is scoped to ``pls:`` callback data and registered before
Hermes' own catch-all, so every other button keeps working."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Optional

from .tap import PATTERN, is_allowed, parse_tap, resolve

logger = logging.getLogger(__name__)
READY_FILE_NAME = "pharmallm-switch.ready.json"


def register(ctx) -> None:
    ctx.register_telegram_handler(_wire)


def _wire(app, adapter) -> None:
    # Runs only when the gateway's Telegram adapter connects. A CLI session loads plugins too but never
    # gets here, so it cannot overwrite the ready file with its own pid.
    from telegram.ext import CallbackQueryHandler
    from gateway.status import get_process_start_time
    from hermes_cli.config import get_hermes_home

    app.add_handler(CallbackQueryHandler(handle_tap, pattern=PATTERN))
    pid = os.getpid()
    # Same function the gateway's own pid record uses, so PharmaLLM can compare the two exactly
    write_ready_file(Path(get_hermes_home()), pid, get_process_start_time(pid))


def write_ready_file(home: Path, pid: int, start_time: Optional[int]) -> Path:
    path = home / READY_FILE_NAME
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps({"pid": pid, "start_time": start_time}), encoding="utf-8")
    os.replace(temp, path)
    return path


async def handle_tap(update, context) -> None:
    query = update.callback_query
    tap = parse_tap(getattr(query, "data", None))
    if query is None or tap is None:
        return
    if not is_allowed(getattr(query.from_user, "id", None), os.environ):
        await query.answer(text="Not authorised")
        return
    # urllib blocks: keep it off the gateway's event loop
    outcome = await asyncio.to_thread(resolve, tap, dict(os.environ))
    await query.answer(text=outcome.toast)
    if outcome.text is None:
        return
    try:
        await query.edit_message_text(outcome.text)
    except Exception as exc:  # an edit failure must not surface as a gateway error
        logger.warning("pharmallm-switch: could not edit the message (%s)", type(exc).__name__)
