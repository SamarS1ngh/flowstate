from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from pathlib import Path

SCHEMA_VERSION = "1"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS songs (
  video_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  duration_s INTEGER,
  analyzed INTEGER NOT NULL DEFAULT 0,
  analyze_error TEXT
);
CREATE TABLE IF NOT EXISTS playlists (playlist_id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS playlist_songs (
  playlist_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, video_id)
);
CREATE TABLE IF NOT EXISTS features (
  video_id TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  mood_happy REAL, mood_sad REAL, mood_relaxed REAL, mood_aggressive REAL,
  danceable REAL, acoustic REAL, party REAL,
  bpm REAL, energy REAL, key TEXT
);
"""


@dataclass
class Song:
    video_id: str
    title: str
    artist: str
    duration_s: int | None = None


@dataclass
class Playlist:
    playlist_id: str
    name: str
    video_ids: list[str] = field(default_factory=list)


@dataclass
class Features:
    embedding: bytes  # float32[200], little-endian
    moods: dict[str, float]  # keys: happy, sad, relaxed, aggressive, danceable, acoustic, party
    bpm: float
    energy: float
    key: str


def connect(path: str | Path) -> sqlite3.Connection:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript(_SCHEMA)
    conn.execute(
        "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)",
        (SCHEMA_VERSION,),
    )
    conn.commit()

    row = conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
    found_version = row[0] if row else None
    if found_version != SCHEMA_VERSION:
        conn.close()
        raise ValueError(
            f"{path}: unsupported schema_version '{found_version}' "
            f"(this analyzer expects '{SCHEMA_VERSION}'); refusing to open a "
            "database that may use a different, incompatible schema"
        )
    return conn


def upsert_songs(conn: sqlite3.Connection, songs: list[Song]) -> None:
    conn.executemany(
        """INSERT INTO songs (video_id, title, artist, duration_s) VALUES (?, ?, ?, ?)
           ON CONFLICT(video_id) DO UPDATE SET
             title=excluded.title, artist=excluded.artist, duration_s=excluded.duration_s""",
        [(s.video_id, s.title, s.artist, s.duration_s) for s in songs],
    )
    conn.commit()


def replace_playlists(conn: sqlite3.Connection, playlists: list[Playlist]) -> None:
    conn.execute("DELETE FROM playlist_songs")
    conn.execute("DELETE FROM playlists")
    for p in playlists:
        conn.execute(
            "INSERT INTO playlists (playlist_id, name) VALUES (?, ?)",
            (p.playlist_id, p.name),
        )
        conn.executemany(
            "INSERT OR IGNORE INTO playlist_songs (playlist_id, video_id, position) VALUES (?, ?, ?)",
            [(p.playlist_id, vid, i) for i, vid in enumerate(p.video_ids)],
        )
    conn.commit()


def unanalyzed_ids(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        "SELECT video_id FROM songs WHERE analyzed = 0 AND analyze_error IS NULL ORDER BY video_id"
    ).fetchall()
    return [r[0] for r in rows]


def store_features(conn: sqlite3.Connection, video_id: str, f: Features) -> None:
    m = f.moods
    conn.execute(
        """INSERT OR REPLACE INTO features
           (video_id, embedding, mood_happy, mood_sad, mood_relaxed, mood_aggressive,
            danceable, acoustic, party, bpm, energy, key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (video_id, f.embedding, m["happy"], m["sad"], m["relaxed"], m["aggressive"],
         m["danceable"], m["acoustic"], m["party"], f.bpm, f.energy, f.key),
    )
    conn.execute("UPDATE songs SET analyzed = 1, analyze_error = NULL WHERE video_id = ?", (video_id,))
    conn.commit()


def mark_error(conn: sqlite3.Connection, video_id: str, msg: str) -> None:
    conn.execute("UPDATE songs SET analyze_error = ? WHERE video_id = ?", (msg[:500], video_id))
    conn.commit()
