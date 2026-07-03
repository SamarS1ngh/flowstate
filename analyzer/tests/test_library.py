from flowstate_analyzer.library import _song_from_track


def test_song_from_track_full():
    t = {
        "videoId": "xyz",
        "title": "Song",
        "artists": [{"name": "A"}, {"name": "B"}],
        "duration_seconds": 213,
    }
    s = _song_from_track(t)
    assert s.video_id == "xyz"
    assert s.title == "Song"
    assert s.artist == "A, B"
    assert s.duration_s == 213


def test_song_from_track_without_video_id_is_skipped():
    assert _song_from_track({"title": "unavailable track"}) is None


def test_song_from_track_missing_fields_get_defaults():
    s = _song_from_track({"videoId": "x"})
    assert s.title == "Unknown"
    assert s.artist == "Unknown"
    assert s.duration_s is None
