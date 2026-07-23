// OAuth device-code ("smart TV") login against YouTube, via youtubei.js's
// built-in OAuth2 flow (Session#oauth, wired through Session#signIn() and
// the 'auth-pending' / 'auth' / 'auth-error' / 'update-credentials' events
// -- see node_modules/youtubei.js/dist/src/core/OAuth2.js and Session.js).
//
// Why this replaces the WebView: Google's login page detects and blocks the
// disguised WebView at credential entry ("Couldn't sign you in -- browser
// may not be secure"), and cookie-paste isn't something we can ask every
// user to do. The device-code flow is the same mechanism smart TVs and game
// consoles use: the app shows a short code and a URL
// (https://www.google.com/device), the user enters the code on ANY
// logged-in browser (phone, laptop, doesn't matter), and this session picks
// up full credentials once they approve -- no WebView, no credential entry
// inside the app at all.
//
// Credential shape persisted: exactly the object youtubei.js hands back on
// 'auth' / 'update-credentials' -- `data.credentials`, an `OAuth2Tokens`:
//   { access_token, refresh_token, expiry_date, expires_in?, scope?,
//     token_type?, client? }
// This is deliberately opaque to us: we never inspect its fields, only
// round-trip it verbatim through authStore's saveOAuthCreds/loadOAuthCreds
// so it can later be handed back to `session.signIn(creds)` to restore a
// session (OAuth2#init(tokens) -> setTokens(tokens) -> refreshes if
// expired -> emits 'auth'). This was confirmed against the installed
// youtubei.js 17.2.0 type declarations
// (node_modules/youtubei.js/dist/src/core/OAuth2.d.ts) and verified live in
// a Node scratch script: Innertube.create() -> session.signIn() emits
// 'auth-pending' with a real { user_code, verification_url, device_code,
// interval, expires_in } payload (see task report for the transcript). We
// deliberately did NOT complete the Google-side approval ourselves --  that
// step is the user's alone, on-device.
//
// retrieve_player is left at its default here (true) rather than forced
// false: Task 3/4 reuse this same authed Innertube for library sync and
// playback, both of which need the player for stream deciphering (see
// src/stream/resolver.ts), so there is no benefit to disabling it and doing
// so would just mean re-fetching player data on first playback anyway.
import {Innertube} from 'youtubei.js';
import type {DeviceAndUserCode, OAuth2Tokens} from 'youtubei.js';
import {loadOAuthCreds, saveOAuthCreds} from './authStore';

/**
 * Maps a thrown auth-flow error (Error, youtubei.js's OAuth2Error, or
 * anything else non-Error a rejected promise/emitted event might carry)
 * into a short, user-facing message. Pure and unit-tested -- everything
 * else in this file is integration glue around youtubei.js/AsyncStorage.
 */
export function describeAuthError(err: unknown): string {
  if (err instanceof Error && err.message) {
    if (/access.*denied/i.test(err.message)) {
      return 'Sign-in was denied. Tap retry to get a new code.';
    }
    if (/expired/i.test(err.message)) {
      return 'That code expired before it was used. Tap retry to get a new one.';
    }
    return err.message;
  }
  return 'Sign-in failed for an unknown reason. Tap retry to try again.';
}

/**
 * Creates a fresh Innertube session and, if OAuth credentials were
 * previously persisted, restores them via `session.signIn(creds)` (this is
 * the same call used to *start* a fresh device-code flow when called with
 * no argument -- passing existing tokens instead makes OAuth2#init() take
 * the "restore" branch: set tokens, refresh if needed, emit 'auth', done --
 * no device code is issued or shown in that case).
 *
 * Also wires 'update-credentials', which the library's own HTTPClient
 * fires whenever a request under the hood triggers a token refresh, so a
 * refreshed access token is never silently un-persisted. That listener is
 * intentionally left attached for the lifetime of the returned Innertube
 * instance, since that instance is meant to be the same one Task 3/4 reuse
 * for library sync + playback (long-lived, not just for the login screen).
 *
 * If no credentials are stored, this simply returns a signed-out Innertube
 * -- callers should treat that as "not logged in" and route to the login
 * screen (startDeviceLogin below) rather than call this and expect it to
 * initiate a fresh device-code flow itself (it never does; see below).
 */
export async function getAuthedInnertube(): Promise<Innertube> {
  const yt = await Innertube.create();
  yt.session.on('update-credentials', ({credentials}) => {
    saveOAuthCreds(credentials).catch(() => {
      // Best-effort: a failed persist here just means the next cold start
      // falls back to a fresh device-code login; it doesn't affect the
      // already-live in-memory session.
    });
  });
  const creds = await loadOAuthCreds();
  if (creds) {
    await yt.session.signIn(creds as OAuth2Tokens);
  }
  return yt;
}

/**
 * Starts a brand-new device-code sign-in on a fresh Innertube session.
 * `onCode` is invoked once the server issues a device/user code (usually
 * within ~1s) with the verification URL (https://www.google.com/device)
 * and the short user code (e.g. "CHC-VTX-PPKH") to render on screen. The
 * returned promise resolves once the user has approved the code in a
 * browser elsewhere AND the resulting credentials have been persisted (the
 * promise deliberately does not resolve on youtubei.js's own internal
 * 'auth' race alone -- see below), or rejects on 'auth-error' (e.g. the
 * user denies access, or the code expires unused -- ~30 min from
 * expires_in).
 *
 * Implementation note on ordering: Session#signIn() itself returns a
 * promise that resolves as soon as 'auth' is emitted, via its own internal
 * `once('auth', ...)` listener registered at call time. Since our
 * `saveOAuthCreds` call also happens inside an 'auth' handler, and listener
 * order for a given event is registration order, registering our handler
 * before calling `session.signIn()` guarantees our save is *initiated*
 * first -- but saveOAuthCreds is async (AsyncStorage), so relying on
 * signIn()'s returned promise instead would risk resolving before the
 * write actually completes. This function therefore ignores signIn()'s own
 * returned promise ON THE RESOLVE SIDE and instead settles its own promise
 * only after `saveOAuthCreds` has actually finished.
 *
 * signIn()'s REJECTION, however, is NOT purely a re-emission of
 * 'auth-error': OAuth2#init() (which signIn() awaits) can throw directly --
 * e.g. getClientID()'s or getDeviceAndUserCode()'s own HTTP fetch failing --
 * *before* a device code even exists to emit 'auth-pending' for, let alone
 * 'auth-error'. That failure only ever surfaces as signIn()'s own promise
 * rejecting; there is no corresponding event for it. An earlier version of
 * this function discarded that rejection (`.catch(() => {})`), which meant
 * a failure at that stage left this promise permanently pending -- the
 * device-code screen stuck on "Getting your code..." forever with no error
 * or retry option surfaced. Confirmed on-device: a first on-device run hit
 * exactly this path and hung indefinitely. Fixed by forwarding signIn()'s
 * rejection into this promise's reject too (harmless no-op if 'auth-error'
 * already rejected it first -- a promise only ever settles once).
 */
export function startDeviceLogin(
  onCode: (verificationUrl: string, userCode: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    Innertube.create()
      .then(yt => {
        yt.session.on('auth-pending', (d: DeviceAndUserCode) => {
          onCode(d.verification_url, d.user_code);
        });
        yt.session.on('auth', ({credentials}) => {
          saveOAuthCreds(credentials).then(resolve, reject);
        });
        yt.session.on('update-credentials', ({credentials}) => {
          saveOAuthCreds(credentials).catch(() => {});
        });
        yt.session.on('auth-error', err => {
          reject(err instanceof Error ? err : new Error(String(err)));
        });
        yt.session.signIn().catch(err => {
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      })
      .catch(reject);
  });
}
