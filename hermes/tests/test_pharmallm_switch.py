"""Tests for the pharmallm-switch Hermes plugin. Stdlib only: no Telegram, no Hermes, no live app."""

import asyncio
import importlib.util
import json
import socketserver
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

PLUGIN_DIR = Path(__file__).resolve().parent.parent / "plugins" / "pharmallm-switch"
TOKEN = "0123456789abcdef0123456789abcdef"


class _LocalHTTPServer(HTTPServer):
    """HTTPServer.server_bind() calls socket.getfqdn(), a reverse-DNS lookup that can stall for tens of
    seconds in a sandboxed environment. The test never needs a real hostname, so skip it."""

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name = "127.0.0.1"
        self.server_port = self.server_address[1]


def load_plugin():
    # Loaded as a package, the way Hermes loads it, so the plugin's relative import resolves
    spec = importlib.util.spec_from_file_location(
        "pharmallm_switch", PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)])
    module = importlib.util.module_from_spec(spec)
    sys.modules["pharmallm_switch"] = module
    spec.loader.exec_module(module)
    return module


plugin = load_plugin()
tap = sys.modules["pharmallm_switch.tap"]


class ParseTapTest(unittest.TestCase):
    def test_reads_confirm_and_cancel(self):
        self.assertEqual(tap.parse_tap(f"pls:ok:{TOKEN}"), tap.Tap("confirm", TOKEN))
        self.assertEqual(tap.parse_tap(f"pls:no:{TOKEN}"), tap.Tap("cancel", TOKEN))

    def test_ignores_anything_else(self):
        for data in ["", "ea:once:1", f"pls:maybe:{TOKEN}", "pls:ok:short", f"pls:ok:{TOKEN}x", None]:
            self.assertIsNone(tap.parse_tap(data))


class AllowedTest(unittest.TestCase):
    def test_only_listed_users(self):
        env = {"TELEGRAM_ALLOWED_USERS": " 424242 , 99"}
        self.assertTrue(tap.is_allowed(424242, env))
        self.assertTrue(tap.is_allowed("99", env))
        self.assertFalse(tap.is_allowed(7, env))
        self.assertFalse(tap.is_allowed(None, env))

    def test_nobody_when_the_list_is_empty(self):
        self.assertFalse(tap.is_allowed(424242, {}))


class OutcomeTest(unittest.TestCase):
    def test_maps_each_app_reply(self):
        confirm, cancel = tap.Tap("confirm", TOKEN), tap.Tap("cancel", TOKEN)
        switching = tap.outcome_for(confirm, tap.AppReply(200, {"status": "switching", "target": "mlx"}))
        self.assertEqual(switching.text, "✅ Switching to mlx — PharmaLLM restarts in a moment")
        self.assertEqual(tap.outcome_for(cancel, tap.AppReply(200, {})).text, "✖ Switch cancelled")
        self.assertEqual(tap.outcome_for(confirm, tap.AppReply(410, {})).text,
                         "⌛ Expired — request the switch again from PharmaLLM")

    def test_keeps_the_buttons_when_the_app_cannot_be_reached(self):
        down = tap.outcome_for(tap.Tap("confirm", TOKEN), tap.AppReply(0, {}, "ConnectionRefusedError"))
        self.assertIsNone(down.text)
        self.assertIn("ConnectionRefusedError", down.toast)
        self.assertIn("401", tap.outcome_for(tap.Tap("confirm", TOKEN), tap.AppReply(401, {})).toast)


class PostJsonTest(unittest.TestCase):
    """Against a test-owned HTTP server on a free port, never the real app."""

    def setUp(self):
        self.seen = []
        seen = self.seen

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                seen.append((self.path, self.headers["Authorization"], body))
                code = 200 if body.get("token") == TOKEN else 410
                payload = json.dumps({"status": "switching", "target": "mlx"} if code == 200 else {"error": "x"})
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(payload.encode())

            def log_message(self, *args):
                pass

        self.server = _LocalHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.env = {"PHARMALLM_URL": f"http://127.0.0.1:{self.server.server_port}/",
                    "PHARMALLM_API_TOKEN": "api-secret"}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_confirms_with_the_bearer_token(self):
        outcome = tap.resolve(tap.Tap("confirm", TOKEN), self.env)
        self.assertEqual(self.seen, [("/api/stack/confirm", "Bearer api-secret", {"token": TOKEN})])
        self.assertTrue(outcome.text.startswith("✅ Switching to mlx"))

    def test_reads_a_410_as_expired(self):
        outcome = tap.resolve(tap.Tap("cancel", "f" * 32), self.env)
        self.assertEqual(self.seen[0][0], "/api/stack/cancel")
        self.assertTrue(outcome.text.startswith("⌛ Expired"))

    def test_unreachable_app_names_the_error_class_and_never_the_token(self):
        reply = tap.post_json("http://127.0.0.1:9/api/stack/confirm", {"token": TOKEN}, "api-secret", timeout=2)
        self.assertEqual(reply.status, 0)
        self.assertTrue(reply.error)
        self.assertNotIn("api-secret", reply.error)


class FakeQuery:
    def __init__(self, data, user_id):
        self.data = data
        self.from_user = mock.Mock(id=user_id)
        self.answers, self.edits = [], []

    async def answer(self, text=None):
        self.answers.append(text)

    async def edit_message_text(self, text):
        self.edits.append(text)


class HandleTapTest(unittest.TestCase):
    ENV = {"TELEGRAM_ALLOWED_USERS": "424242", "PHARMALLM_URL": "http://x", "PHARMALLM_API_TOKEN": "t"}

    def run_tap(self, query, outcome=None):
        update = mock.Mock(callback_query=query)
        resolved = mock.Mock(return_value=outcome)
        with mock.patch.dict("os.environ", self.ENV, clear=True), mock.patch.object(plugin, "resolve", resolved):
            asyncio.run(plugin.handle_tap(update, None))
        return resolved

    def test_answers_and_edits_for_an_allowed_user(self):
        query = FakeQuery(f"pls:ok:{TOKEN}", 424242)
        resolved = self.run_tap(query, tap.Outcome("✅ Switching to mlx", "✅ Switching to mlx — restarts"))
        self.assertEqual(resolved.call_args.args[0], tap.Tap("confirm", TOKEN))
        self.assertEqual(query.answers, ["✅ Switching to mlx"])
        self.assertEqual(query.edits, ["✅ Switching to mlx — restarts"])

    def test_refuses_a_stranger_without_calling_the_app(self):
        query = FakeQuery(f"pls:ok:{TOKEN}", 7)
        resolved = self.run_tap(query)
        resolved.assert_not_called()
        self.assertEqual(query.answers, ["Not authorised"])
        self.assertEqual(query.edits, [])

    def test_leaves_the_message_alone_when_the_outcome_keeps_the_buttons(self):
        query = FakeQuery(f"pls:no:{TOKEN}", 424242)
        self.run_tap(query, tap.Outcome("⚠️ Could not reach PharmaLLM (HTTP 500)", None))
        self.assertEqual(query.edits, [])


class ReadyFileTest(unittest.TestCase):
    def test_writes_pid_and_start_time(self):
        with tempfile.TemporaryDirectory() as home:
            path = plugin.write_ready_file(Path(home), 4242, 777)
            self.assertEqual(json.loads(path.read_text()), {"pid": 4242, "start_time": 777})
            self.assertEqual(path.name, "pharmallm-switch.ready.json")
            self.assertEqual([p.name for p in Path(home).iterdir()], ["pharmallm-switch.ready.json"])


if __name__ == "__main__":
    unittest.main()
