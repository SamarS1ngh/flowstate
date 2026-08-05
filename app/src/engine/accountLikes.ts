// Real-account like/unlike on YouTube. Verified working with the TV-client
// OAuth token (see [[yt-tv-token-capabilities]]): /like/like + /like/removelike
// are the one CLEAN, reversible account write available (playlist add is
// one-way / create is blocked, so we deliberately don't use those).
import {getAuthedInnertube} from '../auth/oauth';

/** Like `videoId` on the signed-in account. Returns false on any failure. */
export async function likeSong(videoId: string): Promise<boolean> {
  try {
    const yt = await getAuthedInnertube();
    await yt.actions.execute('/like/like', {target: {videoId}, client: 'TV'});
    return true;
  } catch {
    return false;
  }
}

/** Remove a like from `videoId`. Returns false on any failure. */
export async function unlikeSong(videoId: string): Promise<boolean> {
  try {
    const yt = await getAuthedInnertube();
    await yt.actions.execute('/like/removelike', {target: {videoId}, client: 'TV'});
    return true;
  } catch {
    return false;
  }
}
