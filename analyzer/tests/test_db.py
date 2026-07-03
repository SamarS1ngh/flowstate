import numpy as np

from flowstate_analyzer import db

MOOD_KEYS = ["happy", "sad", "relaxed", "aggressive", "danceable", "acoustic", "party"]


def make_features():
    emb = np.arange(200, dtype=np.float32).tobytes()
    return db.Features(
        embedding=emb,
        moods={k: 0.5 for k in MOOD_KEYS},
        bpm=120.0,
        energy=0.1,
        key="C major",
    )


def test_connect_creates_schema_and_version(tmp_path):
    conn = db.connect(tmp_path / "sub" / "v.db")  # parent dir auto-created
    version = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0]
    assert version == "1"


def test_upsert_updates_without_duplicating(tmp_path):
    conn = db.connect(tmp_path / "v.db")
    db.upsert_songs(conn, [db.Song("abc", "Title", "Artist", 200)])
    db.upsert_songs(conn, [db.Song("abc", "New Title", "Artist", 200)])
    rows = conn.execute("SELECT video_id, title FROM songs").fetchall()
    assert rows == [("abc", "New Title")]


def test_unanalyzed_and_store_features(tmp_path):
    conn = db.connect(tmp_path / "v.db")
    db.upsert_songs(conn, [db.Song("abc", "T", "A", 1)])
    assert db.unanalyzed_ids(conn) == ["abc"]
    db.store_features(conn, "abc", make_features())
    assert db.unanalyzed_ids(conn) == []
    emb = conn.execute("SELECT embedding FROM features WHERE video_id='abc'").fetchone()[0]
    assert len(emb) == 200 * 4  # float32[200]


def test_mark_error_excludes_from_todo(tmp_path):
    conn = db.connect(tmp_path / "v.db")
    db.upsert_songs(conn, [db.Song("bad", "T", "A", 1)])
    db.mark_error(conn, "bad", "boom")
    assert db.unanalyzed_ids(conn) == []
    err = conn.execute("SELECT analyze_error FROM songs WHERE video_id='bad'").fetchone()[0]
    assert err == "boom"


def test_replace_playlists_is_full_replace(tmp_path):
    conn = db.connect(tmp_path / "v.db")
    db.upsert_songs(conn, [db.Song("a", "T", "A", 1), db.Song("b", "T", "A", 1)])
    db.replace_playlists(conn, [db.Playlist("p1", "Chill", ["a", "b"])])
    db.replace_playlists(conn, [db.Playlist("p1", "Chill", ["b"])])
    rows = conn.execute("SELECT video_id, position FROM playlist_songs").fetchall()
    assert rows == [("b", 0)]
