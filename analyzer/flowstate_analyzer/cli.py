from __future__ import annotations

import argparse
import http.server
import sys
import tempfile
from pathlib import Path

from . import db
from .library import fetch_library


def cmd_run(args) -> None:
    conn = db.connect(args.db)
    print("Syncing library...")
    songs, playlists = fetch_library(args.auth)
    db.upsert_songs(conn, songs)
    db.replace_playlists(conn, playlists)
    todo = db.unanalyzed_ids(conn)
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(songs)} songs in library, {len(todo)} to analyze")
    if not todo:
        print("Nothing to do.")
        return

    # Lazy imports: essentia only exists in Docker, and importing it is slow.
    from .fetch import download_audio
    from .features import Extractor

    extractor = Extractor(args.models, segment_s=args.segment)
    failed = 0
    for i, vid in enumerate(todo, 1):
        print(f"[{i}/{len(todo)}] {vid}", flush=True)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                audio = download_audio(vid, Path(tmp))
                feats = extractor.extract(audio)
            db.store_features(conn, vid, feats)
        except Exception as e:  # record and continue; never abort the batch
            failed += 1
            print(f"  ERROR: {e}", file=sys.stderr)
            db.mark_error(conn, vid, str(e))
    print(f"Done. {len(todo) - failed} analyzed, {failed} failed.")


def make_db_only_handler(db_path: Path) -> type:
    """Build a BaseHTTPRequestHandler that serves *only* db_path's bytes at
    /<db_path.name>, and 404s everything else (including "/"). No directory
    listing, no access to sibling files (e.g. browser.json)."""
    db_path = Path(db_path).resolve()
    route = f"/{db_path.name}"

    class DbOnlyHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path != route:
                self.send_error(404)
                return
            data = db_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, fmt: str, *args) -> None:
            pass  # keep default stderr logging quiet during tests

    return DbOnlyHandler


def cmd_serve(args) -> None:
    db_path = Path(args.db).resolve()
    handler = make_db_only_handler(db_path)
    print(f"Serving only {db_path.name} (not its containing directory) on port {args.port}")
    print(f"On your phone (same wifi): http://<this-machine-ip>:{args.port}/{db_path.name}")
    http.server.HTTPServer(("0.0.0.0", args.port), handler).serve_forever()


def main() -> None:
    p = argparse.ArgumentParser(prog="flowstate-analyzer")
    sub = p.add_subparsers(dest="cmd", required=True)

    run = sub.add_parser("run", help="sync library and analyze new songs")
    run.add_argument("--auth", required=True, help="ytmusicapi browser.json")
    run.add_argument("--db", default="out/vibes.db")
    run.add_argument("--models", default="models")
    run.add_argument("--limit", type=int, help="analyze at most N songs (for testing)")
    run.add_argument(
        "--segment",
        type=int,
        default=120,
        help="seconds of the centered middle segment to analyze per song; 0 = analyze full track",
    )
    run.set_defaults(func=cmd_run)

    srv = sub.add_parser("serve", help="share vibes.db over wifi for the app")
    srv.add_argument("--db", default="out/vibes.db")
    srv.add_argument("--port", type=int, default=8765)
    srv.set_defaults(func=cmd_serve)

    args = p.parse_args()
    args.func(args)
