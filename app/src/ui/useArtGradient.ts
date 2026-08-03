import {useEffect, useState} from 'react';
import ImageColors from 'react-native-image-colors';
import {colors, gradients} from './theme';
import {thumbUrl} from './thumb';

// Mix a hex colour toward black by `amount` (0..1) -> "rgb(r,g,b)".
function darken(hex: string, amount: number): string {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const r = Math.round(parseInt(n.slice(0, 2), 16) * (1 - amount));
  const g = Math.round(parseInt(n.slice(2, 4), 16) * (1 - amount));
  const b = Math.round(parseInt(n.slice(4, 6), 16) * (1 - amount));
  return `rgb(${r},${g},${b})`;
}

/**
 * Derive a "colour-into-black" gradient (3 stops) from a song's artwork, so a
 * screen can glow in the album's colour (the Spotify/Apple now-playing look).
 * Extraction is cached per videoId by the native lib; any failure falls back to
 * the app's violet backdrop so a screen is never left flat. Shared by the
 * Player and the Playlist header.
 */
export function useArtGradient(videoId: string | null | undefined): string[] {
  const [grad, setGrad] = useState<string[]>(gradients.playerBackdrop);
  useEffect(() => {
    let cancelled = false;
    if (!videoId) {
      setGrad(gradients.playerBackdrop);
      return;
    }
    (async () => {
      try {
        const res = await ImageColors.getColors(thumbUrl(videoId, 'hqdefault'), {
          fallback: colors.accent,
          cache: true,
          key: videoId,
        });
        const base =
          res.platform === 'android'
            ? res.vibrant || res.dominant || res.average || colors.accent
            : res.platform === 'ios'
              ? res.primary || res.detail || colors.accent
              : colors.accent;
        if (!cancelled) setGrad([darken(base, 0.5), darken(base, 0.78), colors.bg]);
      } catch {
        if (!cancelled) setGrad(gradients.playerBackdrop);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [videoId]);
  return grad;
}
