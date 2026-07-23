// Auth store: cookie parsing, SAPISIDHASH generation, and persistence of the
// YouTube Music login cookie header. Cookies never leave the device -- they
// are only persisted to AsyncStorage under a namespaced key (see
// Global Constraints in docs/superpowers/plans/2026-07-23-plan-c-login-sync.md).
import {sha1} from 'js-sha1';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'flowstate.auth.v1';
const OAUTH_STORAGE_KEY = 'flowstate.oauth.v1';
const MUSIC_ORIGIN = 'https://music.youtube.com';

/**
 * Parses a `Cookie:`-style header string ("A=1; B=2") into a map of
 * name -> value. Tolerant of irregular whitespace around pairs/separators;
 * values may themselves contain "=" (e.g. base64-encoded cookie values).
 * Segments with no "=" are skipped.
 */
export function parseCookieString(setCookieOrHeader: string): Record<string, string> {
  const result: Record<string, string> = {};
  const segments = setCookieOrHeader.split(';');
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed === '') {
      continue;
    }
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }
    const name = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (name === '') {
      continue;
    }
    result[name] = value;
  }
  return result;
}

/**
 * YouTube's SAPISIDHASH scheme: SHA-1(`${seconds} ${sapisid} ${origin}`),
 * returned as `${seconds}_${hex}` where seconds = floor(nowMs / 1000).
 *
 * Vector derivation (documented, computed once via Node's built-in crypto
 * module -- see __tests__/auth.test.ts for the exact script used):
 *   sapisid = 'abc123DEF456', origin = 'https://music.youtube.com',
 *   nowMs = 1700000000000 (seconds = 1700000000)
 *   => '1700000000_523b347dc761960824d5cee9cce8e04db5cd0114'
 */
export function sapisidHash(sapisid: string, origin: string, nowMs: number): string {
  const seconds = Math.floor(nowMs / 1000);
  const input = `${seconds} ${sapisid} ${origin}`;
  const hex = sha1(input);
  return `${seconds}_${hex}`;
}

/**
 * Builds the header set needed to make an authenticated YouTube Music
 * Innertube request: extracts SAPISID (falling back to __Secure-3PAPISID)
 * from the given cookie header and computes a fresh SAPISIDHASH against the
 * music.youtube.com origin.
 */
export function buildAuthHeaders(cookieHeader: string, nowMs: number): Record<string, string> {
  const cookies = parseCookieString(cookieHeader);
  const sapisid = cookies['SAPISID'] ?? cookies['__Secure-3PAPISID'];
  if (!sapisid) {
    throw new Error(
      'buildAuthHeaders: no SAPISID or __Secure-3PAPISID cookie found in cookie header',
    );
  }
  return {
    cookie: cookieHeader,
    authorization: `SAPISIDHASH ${sapisidHash(sapisid, MUSIC_ORIGIN, nowMs)}`,
    'x-origin': MUSIC_ORIGIN,
  };
}

/**
 * Persists the raw cookie header to AsyncStorage. Thin passthrough, not
 * unit-tested (native dependency) -- see Global Constraints.
 */
export async function saveAuth(cookieHeader: string): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, cookieHeader);
}

/** Loads the previously-persisted cookie header, or null if none is stored. */
export async function loadAuth(): Promise<string | null> {
  return AsyncStorage.getItem(STORAGE_KEY);
}

/** Clears the persisted cookie header (used on logout). */
export async function clearAuth(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}

// --- OAuth device-flow credentials (Plan C Task 2) ---------------------
//
// The cookie-based functions above stay as-is (cookie-paste remains a
// hidden fallback -- see LoginScreen). Device-code OAuth persists a
// completely different shape: youtubei.js's `OAuth2Tokens` object
// (access_token/refresh_token/expiry_date/scope/token_type/client), read
// straight off the `credentials` field of the session's 'auth' and
// 'update-credentials' events (see src/auth/oauth.ts) and later handed
// back to `session.signIn(creds)` verbatim to restore a session. Stored as
// opaque JSON under its own key so it never collides with, or needs to be
// parsed like, the cookie header string.

/** Persists an OAuth credentials object (JSON-serializable) to AsyncStorage. */
export async function saveOAuthCreds(creds: object): Promise<void> {
  await AsyncStorage.setItem(OAUTH_STORAGE_KEY, JSON.stringify(creds));
}

/**
 * Loads the previously-persisted OAuth credentials object, or null if none
 * is stored (or the stored value is corrupt JSON -- treated the same as
 * "not logged in" rather than throwing, since callers use this purely to
 * decide whether to attempt a session restore).
 */
export async function loadOAuthCreds(): Promise<object | null> {
  const raw = await AsyncStorage.getItem(OAUTH_STORAGE_KEY);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Clears the persisted OAuth credentials (used on logout). */
export async function clearOAuthCreds(): Promise<void> {
  await AsyncStorage.removeItem(OAUTH_STORAGE_KEY);
}
