export interface Song {
  videoId: string;
  title: string;
  artist: string;
  durationS: number | null;
  hasVibe: boolean;
}

export interface Playlist {
  playlistId: string;
  name: string;
  trackCount: number;
}
