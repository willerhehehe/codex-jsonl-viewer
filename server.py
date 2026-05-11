#!/usr/bin/env python3
from __future__ import annotations

import json
import argparse
import mimetypes
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse


DEFAULT_ROOT = "~/.codex/sessions"
STATIC_DIR = Path(__file__).with_name("static")


def resolve_sessions_root(root_text: str) -> Path:
    return Path(root_text).expanduser().resolve(strict=False)


def date_to_dir(root: Path, date_text: str) -> Path:
    parsed = datetime.strptime(date_text, "%Y-%m-%d")
    return root / f"{parsed.year:04d}" / f"{parsed.month:02d}" / f"{parsed.day:02d}"


def list_dates(root: Path) -> list[str]:
    if not root.exists():
        return []

    dates: list[str] = []
    for year_dir in root.iterdir():
        if not year_dir.is_dir() or not _digits(year_dir.name, 4):
            continue
        for month_dir in year_dir.iterdir():
            if not month_dir.is_dir() or not _digits(month_dir.name, 2):
                continue
            for day_dir in month_dir.iterdir():
                if not day_dir.is_dir() or not _digits(day_dir.name, 2):
                    continue
                date_text = f"{year_dir.name}-{month_dir.name}-{day_dir.name}"
                try:
                    datetime.strptime(date_text, "%Y-%m-%d")
                except ValueError:
                    continue
                dates.append(date_text)

    return sorted(dates, reverse=True)


def list_rollout_files(root: Path, date_text: str) -> list[dict[str, object]]:
    day_dir = date_to_dir(root, date_text)
    if not day_dir.exists():
        return []

    files = [path for path in day_dir.glob("rollout-*.jsonl") if path.is_file()]
    files.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    return [_file_info(path) for path in files]


def safe_rollout_path(root: Path, date_text: str, file_name: str) -> Path:
    if Path(file_name).name != file_name:
        raise ValueError("file must be a rollout JSONL file name, not a path")
    if not file_name.startswith("rollout-") or not file_name.endswith(".jsonl"):
        raise ValueError("file must match rollout-*.jsonl")

    day_dir = date_to_dir(root, date_text).resolve(strict=False)
    path = (day_dir / file_name).resolve(strict=False)
    if not path.is_relative_to(day_dir):
        raise ValueError("file is outside the selected date directory")
    return path


def parse_jsonl_line(line: str, line_no: int, offset: int) -> dict[str, object]:
    raw = line.rstrip("\n")
    try:
        record: Any = json.loads(raw)
        error = None
    except json.JSONDecodeError as exc:
        record = {"raw": raw}
        error = str(exc)

    return {
        "lineNo": line_no,
        "offset": offset,
        "nextOffset": offset + len(line.encode("utf-8")),
        "rawLine": raw,
        "record": record,
        "error": error,
    }


def read_recent_jsonl(path: Path, limit: int) -> tuple[list[dict[str, object]], int]:
    if limit <= 0 or not path.exists():
        return [], 0

    file_size = path.stat().st_size
    data, data_offset = _read_tail_bytes(path, limit)
    lines = data.splitlines(keepends=True)
    if len(lines) > limit:
        skipped = len(lines) - limit
        data_offset += sum(len(line) for line in lines[:skipped])
        lines = lines[skipped:]

    records: list[dict[str, object]] = []
    offset = data_offset
    first_line_no = _count_lines_before(path, data_offset) + 1
    for index, line_bytes in enumerate(lines):
        line_text = line_bytes.decode("utf-8", errors="replace")
        records.append(parse_jsonl_line(line_text, first_line_no + index, offset))
        offset += len(line_bytes)

    return records, file_size


class JsonlTailer:
    def __init__(self, path: Path, offset: int = 0):
        self.path = path
        self.offset = offset
        self._buffer = ""
        self._line_no = _count_lines_before(path, offset) + 1 if path.exists() else 1

    def read_available(self) -> list[dict[str, object]]:
        if not self.path.exists():
            return []

        with self.path.open("r", encoding="utf-8", errors="replace") as handle:
            handle.seek(self.offset)
            chunk = handle.read()
            self.offset = handle.tell()

        if not chunk:
            return []

        combined = self._buffer + chunk
        if combined.endswith("\n"):
            complete_lines = combined.splitlines(keepends=True)
            self._buffer = ""
        else:
            complete_lines = combined.splitlines(keepends=True)
            self._buffer = complete_lines.pop() if complete_lines else combined

        records: list[dict[str, object]] = []
        line_offset = self.offset - len(chunk.encode("utf-8")) - len(self._buffer.encode("utf-8"))
        for line in complete_lines:
            records.append(parse_jsonl_line(line, self._line_no, line_offset))
            self._line_no += 1
            line_offset += len(line.encode("utf-8"))
        return records


class JsonlViewerServer(ThreadingHTTPServer):
    def __init__(self, server_address, root: Path, static_dir: Path):
        super().__init__(server_address, JsonlViewerHandler)
        self.sessions_root = root
        self.static_dir = static_dir


class JsonlViewerHandler(BaseHTTPRequestHandler):
    server: JsonlViewerServer

    def do_GET(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/dates":
                self._handle_dates()
            elif parsed.path == "/api/files":
                self._handle_files(parsed.query)
            elif parsed.path == "/api/initial":
                self._handle_initial(parsed.query)
            elif parsed.path == "/api/stream":
                self._handle_stream(parsed.query)
            else:
                self._handle_static(parsed.path)
        except ValueError as exc:
            self._write_json({"error": str(exc)}, status=400)
        except FileNotFoundError as exc:
            self._write_json({"error": str(exc)}, status=404)
        except BrokenPipeError:
            return

    def log_message(self, format, *args):
        return

    def _handle_dates(self):
        self._write_json(
            {
                "root": str(self.server.sessions_root),
                "dates": list_dates(self.server.sessions_root),
                "today": datetime.now().strftime("%Y-%m-%d"),
            }
        )

    def _handle_files(self, query: str):
        params = _params(query)
        date_text = _required(params, "date")
        self._write_json({"date": date_text, "files": list_rollout_files(self.server.sessions_root, date_text)})

    def _handle_initial(self, query: str):
        params = _params(query)
        date_text = _required(params, "date")
        file_name = _required(params, "file")
        limit = _bounded_int(params.get("limit", ["200"])[0], default=200, minimum=1, maximum=1000)
        path = safe_rollout_path(self.server.sessions_root, date_text, file_name)
        records, offset = read_recent_jsonl(path, limit)
        self._write_json(
            {
                "date": date_text,
                "file": file_name,
                "path": str(path),
                "records": records,
                "offset": offset,
            }
        )

    def _handle_stream(self, query: str):
        params = _params(query)
        date_text = _required(params, "date")
        file_name = _required(params, "file")
        offset = _bounded_int(params.get("offset", ["0"])[0], default=0, minimum=0, maximum=10**15)
        path = safe_rollout_path(self.server.sessions_root, date_text, file_name)

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        tailer = JsonlTailer(path, offset=offset)
        while True:
            records = tailer.read_available()
            if records:
                for record in records:
                    self.wfile.write(f"data: {json.dumps(record, ensure_ascii=False)}\n\n".encode("utf-8"))
                self.wfile.flush()
            else:
                self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
            time.sleep(0.5)

    def _handle_static(self, raw_path: str):
        if raw_path in ("", "/"):
            relative = Path("index.html")
        else:
            relative = Path(unquote(raw_path.lstrip("/")))

        if relative.parts and relative.parts[0] == "static":
            relative = Path(*relative.parts[1:])
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("invalid static path")

        path = (self.server.static_dir / relative).resolve(strict=False)
        if not path.is_relative_to(self.server.static_dir.resolve(strict=False)) or not path.is_file():
            raise FileNotFoundError(raw_path)

        body = path.read_bytes()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _write_json(self, payload: dict[str, object], status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def create_http_server(address, root: Path | str | None = None, static_dir: Path | str | None = None) -> JsonlViewerServer:
    sessions_root = resolve_sessions_root(str(root or DEFAULT_ROOT))
    static_root = Path(static_dir).resolve(strict=False) if static_dir else STATIC_DIR.resolve(strict=False)
    return JsonlViewerServer(address, sessions_root, static_root)


def _digits(value: str, size: int) -> bool:
    return len(value) == size and value.isdigit()


def _file_info(path: Path) -> dict[str, object]:
    stat = path.stat()
    return {
        "name": path.name,
        "path": str(path),
        "size": stat.st_size,
        "modifiedAt": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
        "mtime": stat.st_mtime,
    }


def _read_tail_bytes(path: Path, line_limit: int) -> tuple[bytes, int]:
    chunk_size = 64 * 1024
    file_size = path.stat().st_size
    data = bytearray()
    position = file_size

    with path.open("rb") as handle:
        while position > 0 and data.count(b"\n") <= line_limit:
            read_size = min(chunk_size, position)
            position -= read_size
            handle.seek(position)
            data[:0] = handle.read(read_size)

    return bytes(data), position


def _count_lines_before(path: Path, offset: int) -> int:
    if offset <= 0 or not path.exists():
        return 0

    count = 0
    remaining = offset
    with path.open("rb") as handle:
        while remaining > 0:
            chunk = handle.read(min(64 * 1024, remaining))
            if not chunk:
                break
            count += chunk.count(b"\n")
            remaining -= len(chunk)
    return count


def _params(query: str) -> dict[str, list[str]]:
    return parse_qs(query, keep_blank_values=True)


def _required(params: dict[str, list[str]], key: str) -> str:
    values = params.get(key)
    if not values or not values[0]:
        raise ValueError(f"missing required parameter: {key}")
    return values[0]


def _bounded_int(value: str, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except ValueError:
        return default
    return max(minimum, min(maximum, parsed))


def main() -> int:
    parser = argparse.ArgumentParser(description="Tail Codex session JSONL files in a local browser UI.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--root", default=DEFAULT_ROOT)
    args = parser.parse_args()

    httpd = create_http_server((args.host, args.port), root=args.root)
    host, port = httpd.server_address
    print(f"Serving JSONL Session Viewer at http://{host}:{port}")
    print(f"Session root: {httpd.sessions_root}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
