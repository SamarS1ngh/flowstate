export interface Song {
  videoId: string;
  title: string;
  artist: string;
  durationS: number | null;
  hasVibe: boolean;
  // True when a full audio file for this song is saved on-device for offline
  // playback (see db `downloads` table). Optional so callers/fixtures that
  // don't care about offline state can omit it.
  hasDownload?: boolean;
}

export interface Playlist {
  playlistId: string;
  name: string;
  trackCount: number;
}
