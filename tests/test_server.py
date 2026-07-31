import json
import threading
import urllib.request
import tempfile
import time
import unittest
from pathlib import Path

import server


class BackendHelperTests(unittest.TestCase):
    def test_default_sessions_root_expands_home(self):
        root = server.resolve_sessions_root("~/.codex/sessions")

        self.assertTrue(str(root).endswith(".codex/sessions"))
        self.assertNotIn("~", str(root))
        self.assertTrue(root.is_absolute())

    def test_date_to_dir_uses_year_month_day_segments(self):
        root = Path("/tmp/sessions")

        self.assertEqual(
            server.date_to_dir(root, "2026-05-09"),
            Path("/tmp/sessions/2026/05/09"),
        )

    def test_list_dates_returns_existing_day_directories_descending(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "2026" / "05" / "08").mkdir(parents=True)
            (root / "2026" / "05" / "09").mkdir(parents=True)
            (root / "2026" / "bad" / "10").mkdir(parents=True)

            self.assertEqual(server.list_dates(root), ["2026-05-09", "2026-05-08"])

    def test_list_rollout_files_sorts_by_modified_time_descending(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            day = root / "2026" / "05" / "09"
            day.mkdir(parents=True)
            older = day / "rollout-older.jsonl"
            newer = day / "rollout-newer.jsonl"
            ignored = day / "notes.jsonl"
            older.write_text("{}\n", encoding="utf-8")
            time.sleep(0.01)
            newer.write_text("{}\n", encoding="utf-8")
            ignored.write_text("{}\n", encoding="utf-8")

            files = server.list_rollout_files(root, "2026-05-09")

            self.assertEqual([item["name"] for item in files], ["rollout-newer.jsonl", "rollout-older.jsonl"])
            self.assertEqual(files[0]["size"], 3)
            self.assertIn("modifiedAt", files[0])

    def test_parse_jsonl_line_returns_parsed_records_and_parse_errors(self):
        line = '{"type":"event_msg"}\n'
        parsed = server.parse_jsonl_line(line, 7, 128)
        broken = server.parse_jsonl_line('{"type":', 8, 151)

        self.assertEqual(parsed["lineNo"], 7)
        self.assertEqual(parsed["offset"], 128)
        self.assertEqual(parsed["nextOffset"], 128 + len(line.encode("utf-8")))
        self.assertEqual(parsed["rawLine"], line.rstrip("\n"))
        self.assertEqual(parsed["record"]["type"], "event_msg")
        self.assertIsNone(parsed["error"])
        self.assertEqual(broken["record"], {"raw": '{"type":'})
        self.assertIn("Expecting value", broken["error"])

    def test_read_recent_jsonl_returns_bounded_recent_records_and_next_offset(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rollout-test.jsonl"
            path.write_text(
                "\n".join(json.dumps({"i": i}) for i in range(5)) + "\n",
                encoding="utf-8",
            )

            records, offset = server.read_recent_jsonl(path, limit=2)

            self.assertEqual([item["record"]["i"] for item in records], [3, 4])
            self.assertEqual(offset, path.stat().st_size)

    def test_jsonl_tailer_reads_only_appended_complete_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rollout-test.jsonl"
            path.write_text('{"i":1}\n', encoding="utf-8")
            tailer = server.JsonlTailer(path, offset=path.stat().st_size)

            with path.open("a", encoding="utf-8") as handle:
                handle.write('{"i":2}\n{"i":')

            first = tailer.read_available()
            self.assertEqual([item["record"]["i"] for item in first], [2])

            with path.open("a", encoding="utf-8") as handle:
                handle.write("3}\n")

            second = tailer.read_available()
            self.assertEqual([item["record"]["i"] for item in second], [3])

    def test_summarize_session_turns_groups_content_and_token_deltas(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rollout-turns.jsonl"
            path.write_text(
                "\n".join(json.dumps(record) for record in turn_fixture_records()) + "\n",
                encoding="utf-8",
            )

            summary = server.summarize_session_turns(path)

            self.assertEqual(len(summary["turns"]), 2)
            self.assertEqual(summary["session"]["id"], "session-test")
            self.assertEqual(summary["session"]["cwd"], "/tmp")
            self.assertEqual(summary["session"]["originator"], "Codex Desktop")
            self.assertEqual(summary["turns"][0]["id"], "turn-2")
            self.assertEqual(summary["turns"][0]["status"], "aborted")
            self.assertEqual(summary["turns"][0]["tokenDelta"]["total_tokens"], 80)
            first = summary["turns"][1]
            self.assertEqual(first["userMessage"], "Build a turn view")
            self.assertEqual(first["assistantMessage"], "Implemented it")
            self.assertEqual(first["toolCount"], 1)
            self.assertEqual(first["composition"]["tools"]["events"], 2)
            self.assertEqual(first["tokenDelta"]["total_tokens"], 120)

            records = server.read_jsonl_range(path, first["startOffset"], first["endOffset"])
            self.assertEqual(records[0]["record"]["payload"]["type"], "task_started")
            self.assertEqual(records[-1]["record"]["payload"]["type"], "task_complete")


class ApiTests(unittest.TestCase):
    def test_api_lists_dates_files_and_initial_recent_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            day = root / "2026" / "05" / "09"
            day.mkdir(parents=True)
            path = day / "rollout-test.jsonl"
            path.write_text(
                "\n".join(json.dumps({"i": i, "type": "event_msg"}) for i in range(4)) + "\n",
                encoding="utf-8",
            )

            with running_server(root) as base_url:
                metadata = get_json(f"{base_url}/api/meta")
                dates = get_json(f"{base_url}/api/dates")
                files = get_json(f"{base_url}/api/files?date=2026-05-09")
                initial = get_json(f"{base_url}/api/initial?date=2026-05-09&file=rollout-test.jsonl&limit=2")

            package = json.loads(server.PACKAGE_JSON.read_text(encoding="utf-8"))
            self.assertEqual(metadata["version"], package["version"])
            self.assertEqual(dates["dates"], ["2026-05-09"])
            self.assertEqual(dates["root"], str(root.resolve()))
            self.assertEqual(files["files"][0]["name"], "rollout-test.jsonl")
            self.assertEqual([item["record"]["i"] for item in initial["records"]], [2, 3])
            self.assertEqual(initial["offset"], path.stat().st_size)

    def test_api_rejects_unsafe_rollout_file_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "2026" / "05" / "09").mkdir(parents=True)

            with running_server(root) as base_url:
                with self.assertRaises(urllib.error.HTTPError) as raised:
                    get_json(f"{base_url}/api/initial?date=2026-05-09&file=../secret.jsonl")

            self.assertEqual(raised.exception.code, 400)
            raised.exception.close()

    def test_api_serves_turn_summaries_and_lazy_turn_events(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            day = root / "2026" / "05" / "09"
            day.mkdir(parents=True)
            path = day / "rollout-turns.jsonl"
            path.write_text(
                "\n".join(json.dumps(record) for record in turn_fixture_records()) + "\n",
                encoding="utf-8",
            )

            with running_server(root) as base_url:
                summary = get_json(f"{base_url}/api/turns?date=2026-05-09&file=rollout-turns.jsonl")
                turn = next(item for item in summary["turns"] if item["id"] == "turn-1")
                detail = get_json(
                    f"{base_url}/api/turn-events?date=2026-05-09&file=rollout-turns.jsonl"
                    f"&start={turn['startOffset']}&end={turn['endOffset']}"
                )

            self.assertEqual(len(summary["turns"]), 2)
            self.assertEqual(detail["records"][0]["record"]["payload"]["turn_id"], "turn-1")
            self.assertEqual(detail["records"][-1]["record"]["payload"]["type"], "task_complete")

    def test_static_browser_files_are_served(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            with running_server(root) as base_url:
                html = get_text(f"{base_url}/")
                js = get_text(f"{base_url}/static/app.js")
                css = get_text(f"{base_url}/static/styles.css")
                icon = get_text(f"{base_url}/static/icon.svg")

            self.assertIn("Codex Session Viewer", html)
            self.assertIn('id="appVersion"', html)
            self.assertIn('rel="icon"', html)
            self.assertIn("extractFieldPaths", js)
            self.assertIn("loadAppMetadata", js)
            self.assertIn(".app-shell", css)
            self.assertIn(".app-version", css)
            self.assertIn("<svg", icon)

    def test_static_browser_files_include_readability_layout_hooks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            with running_server(root) as base_url:
                html = get_text(f"{base_url}/")
                js = get_text(f"{base_url}/static/app.js")
                css = get_text(f"{base_url}/static/styles.css")

            self.assertIn("inspectorTabs", html)
            self.assertIn("renderSemanticEvent", js)
            self.assertIn("renderEventDetails", js)
            self.assertIn("copy-event", css)
            self.assertIn("inspector-content", css)

    def test_static_browser_files_include_event_order_control(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            with running_server(root) as base_url:
                html = get_text(f"{base_url}/")
                js = get_text(f"{base_url}/static/app.js")

            self.assertIn("eventOrderSelect", html)
            self.assertIn("orderedRecords", js)
            self.assertIn("latest-top", html)

    def test_static_browser_files_default_latest_top_and_preserve_scroll_on_selection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            with running_server(root) as base_url:
                html = get_text(f"{base_url}/")
                js = get_text(f"{base_url}/static/app.js")

            self.assertIn('option value="latest-top" selected', html)
            self.assertIn('eventOrder: "latest-top"', js)
            self.assertIn("function renderEvents(options = {})", js)
            self.assertIn("renderEvents({ preserveScroll: true })", js)
            self.assertIn("preserveScrollPosition", js)

    def test_static_browser_files_include_semantic_stream_and_inspector(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            with running_server(root) as base_url:
                html = get_text(f"{base_url}/")
                js = get_text(f"{base_url}/static/app.js")
                css = get_text(f"{base_url}/static/styles.css")

            self.assertIn("eventFilterBar", html)
            self.assertIn("inspectorPanel", html)
            self.assertIn("renderSemanticEvent", js)
            self.assertIn("renderInspector", js)
            self.assertIn("findRelatedEvents", js)
            self.assertIn("json-tree", css)

    def test_static_browser_files_include_turn_ledger_and_context_controls(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            with running_server(root) as base_url:
                html = get_text(f"{base_url}/")
                js = get_text(f"{base_url}/static/app.js")
                css = get_text(f"{base_url}/static/styles.css")

            self.assertIn("viewTabs", html)
            self.assertIn("turnOverview", html)
            self.assertIn("data-turn-density", html)
            self.assertIn("renderCompactTurn", js)
            self.assertIn("renderTurnSummaryInspector", js)
            self.assertIn("loadTurnRecords", js)
            self.assertIn("turn-ledger", css)
            self.assertIn("composition-bar", css)
            self.assertIn("session-composition-total", css)
            self.assertIn("copyHandoffButton", html)
            self.assertIn("buildSessionHandoff", js)
            self.assertIn("handoffObjective", js)
            self.assertIn("renderTurnStructuredInspector", js)
            self.assertIn("turnRecordsForInspector", js)
            self.assertIn("renderTurnPhaseSummaryInspector", js)
            self.assertIn("data-inspect-turn-line", js)
            self.assertIn("turn-raw-detail", css)
            self.assertRegex(
                css,
                r"\.turn-raw-detail \.raw-json\s*\{[^}]*overflow: auto;",
            )
            self.assertIn("turn-record-node", css)
            self.assertIn("turn-phase.selected", css)

    def test_static_browser_files_include_independent_scroll_and_wide_inspector(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            with running_server(root) as base_url:
                html = get_text(f"{base_url}/")
                js = get_text(f"{base_url}/static/app.js")
                css = get_text(f"{base_url}/static/styles.css")

            self.assertIn("inspectorWideButton", html)
            self.assertIn("toggleInspectorWide", js)
            self.assertIn("inspector-wide", css)
            self.assertIn("height: 100vh", css)
            self.assertIn("overflow: hidden", css)

    def test_static_browser_files_include_resizable_inspector_divider(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            with running_server(root) as base_url:
                html = get_text(f"{base_url}/")
                js = get_text(f"{base_url}/static/app.js")
                css = get_text(f"{base_url}/static/styles.css")

            self.assertIn("inspectorResizeHandle", html)
            self.assertIn('role="separator"', html)
            self.assertIn("initResizableInspector", js)
            self.assertIn("setInspectorWidth", js)
            self.assertIn("resize-handle", css)
            self.assertIn("col-resize", css)
            self.assertIn("--inspector-width", css)

    def test_static_browser_files_include_structured_tree_expansion_controls(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            with running_server(root) as base_url:
                js = get_text(f"{base_url}/static/app.js")
                css = get_text(f"{base_url}/static/styles.css")

            self.assertIn('data-tree-action="expand-all"', js)
            self.assertIn('data-tree-action="collapse-all"', js)
            self.assertIn("handleInspectorTreeAction", js)
            self.assertIn("inspector-tree-toolbar", css)
            self.assertIn("tree-action", css)

    def test_static_browser_files_include_embedded_output_renderer(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            with running_server(root) as base_url:
                js = get_text(f"{base_url}/static/app.js")
                css = get_text(f"{base_url}/static/styles.css")

            self.assertIn("parseEmbeddedJsonText", js)
            self.assertIn("renderRichValue", js)
            self.assertIn("renderRichMarkdown", js)
            self.assertIn("rich-embedded-json", js)
            self.assertIn("rich-markdown", css)
            self.assertIn("rich-code-block", css)
            self.assertIn(".rich-markdown .rich-code-block > code", css)
            self.assertIn("background: transparent", css)
            self.assertIn("color: inherit", css)
            self.assertIn("rich-json", css)


class running_server:
    def __init__(self, root: Path):
        self.root = root
        self.httpd = None
        self.thread = None

    def __enter__(self) -> str:
        self.httpd = server.create_http_server(("127.0.0.1", 0), self.root)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.httpd.server_address
        return f"http://{host}:{port}"

    def __exit__(self, exc_type, exc, tb):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=2)


def get_json(url: str):
    with local_url_opener().open(url, timeout=3) as response:
        return json.loads(response.read().decode("utf-8"))


def get_text(url: str):
    with local_url_opener().open(url, timeout=3) as response:
        return response.read().decode("utf-8")


def local_url_opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def turn_fixture_records():
    def usage(input_tokens, output_tokens, reasoning_tokens, total_tokens):
        return {
            "type": "event_msg",
            "timestamp": "2026-05-09T10:00:05Z",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": input_tokens,
                        "cached_input_tokens": input_tokens // 2,
                        "cache_write_input_tokens": 0,
                        "output_tokens": output_tokens,
                        "reasoning_output_tokens": reasoning_tokens,
                        "total_tokens": total_tokens,
                    }
                },
            },
        }

    return [
        {"type": "session_meta", "timestamp": "2026-05-09T09:59:59Z", "payload": {"session_id": "session-test", "cwd": "/tmp", "originator": "Codex Desktop"}},
        {"type": "event_msg", "timestamp": "2026-05-09T10:00:00Z", "payload": {"type": "task_started", "turn_id": "turn-1"}},
        {"type": "turn_context", "timestamp": "2026-05-09T10:00:00Z", "payload": {"turn_id": "turn-1", "cwd": "/tmp"}},
        {"type": "event_msg", "timestamp": "2026-05-09T10:00:01Z", "payload": {"type": "user_message", "message": "Build a turn view"}},
        {"type": "response_item", "timestamp": "2026-05-09T10:00:02Z", "payload": {"type": "reasoning", "summary": []}},
        {"type": "response_item", "timestamp": "2026-05-09T10:00:03Z", "payload": {"type": "function_call", "name": "read_file", "call_id": "1"}},
        {"type": "response_item", "timestamp": "2026-05-09T10:00:04Z", "payload": {"type": "function_call_output", "output": "ok", "call_id": "1"}},
        {"type": "event_msg", "timestamp": "2026-05-09T10:00:05Z", "payload": {"type": "agent_message", "message": "Implemented it"}},
        usage(100, 15, 5, 120),
        {"type": "event_msg", "timestamp": "2026-05-09T10:00:06Z", "payload": {"type": "task_complete", "turn_id": "turn-1", "duration_ms": 6000}},
        {"type": "event_msg", "timestamp": "2026-05-09T10:01:00Z", "payload": {"type": "task_started", "turn_id": "turn-2"}},
        {"type": "event_msg", "timestamp": "2026-05-09T10:01:01Z", "payload": {"type": "user_message", "message": "Stop the turn"}},
        usage(170, 22, 8, 200),
        {"type": "event_msg", "timestamp": "2026-05-09T10:01:03Z", "payload": {"type": "turn_aborted", "turn_id": "turn-2", "duration_ms": 3000}},
    ]


if __name__ == "__main__":
    unittest.main()
