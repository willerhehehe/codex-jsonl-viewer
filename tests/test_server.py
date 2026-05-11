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
                dates = get_json(f"{base_url}/api/dates")
                files = get_json(f"{base_url}/api/files?date=2026-05-09")
                initial = get_json(f"{base_url}/api/initial?date=2026-05-09&file=rollout-test.jsonl&limit=2")

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

    def test_static_browser_files_are_served(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            with running_server(root) as base_url:
                html = get_text(f"{base_url}/")
                js = get_text(f"{base_url}/static/app.js")
                css = get_text(f"{base_url}/static/styles.css")

            self.assertIn("Codex Session Viewer", html)
            self.assertIn("extractFieldPaths", js)
            self.assertIn(".app-shell", css)

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


if __name__ == "__main__":
    unittest.main()
