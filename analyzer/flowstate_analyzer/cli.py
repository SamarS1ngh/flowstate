from __future__ import annotations

import argparse
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

    extractor = Extractor(args.models)
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


def cmd_serve(args) -> None:
    import functools
    import http.server

    db_path = Path(args.db).resolve()
    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=str(db_path.parent)
    )
    print(f"Serving {db_path.parent} on port {args.port}")
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
    run.set_defaults(func=cmd_run)

    srv = sub.add_parser("serve", help="share vibes.db over wifi for the app")
    srv.add_argument("--db", default="out/vibes.db")
    srv.add_argument("--port", type=int, default=8765)
    srv.set_defaults(func=cmd_serve)

    args = p.parse_args()
    args.func(args)
