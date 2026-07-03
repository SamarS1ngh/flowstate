from __future__ import annotations

from ytmusicapi import YTMusic

from .db import Playlist, Song


def _song_from_track(t: dict) -> Song | None:
    vid = t.get("videoId")
    if not vid:
        return None
    artists = t.get("artists") or []
    artist = ", ".join(a["name"] for a in artists if a.get("name")) or "Unknown"
    return Song(
        video_id=vid,
        title=t.get("title") or "Unknown",
        artist=artist,
        duration_s=t.get("duration_seconds"),
    )


def fetch_library(auth_path: str) -> tuple[list[Song], list[Playlist]]:
    yt = YTMusic(auth_path)
    songs: dict[str, Song] = {}
    for t in yt.get_library_songs(limit=None):
        s = _song_from_track(t)
        if s:
            songs[s.video_id] = s
    playlists: list[Playlist] = []
    for p in yt.get_library_playlists(limit=None):
        pid = p["playlistId"]
        full = yt.get_playlist(pid, limit=None)
        vids: list[str] = []
        for t in full.get("tracks", []):
            s = _song_from_track(t)
            if s:
                songs.setdefault(s.video_id, s)
                vids.append(s.video_id)
        playlists.append(
            Playlist(playlist_id=pid, name=p.get("title") or "Untitled", video_ids=vids)
        )
    return list(songs.values()), playlists
