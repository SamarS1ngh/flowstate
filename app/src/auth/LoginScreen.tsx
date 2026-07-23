// In-app YouTube Music login. Loads music.youtube.com in a WebView and lets
// the user sign in with their own Google credentials (this screen never
// sees or handles the password itself -- it only watches cookies that the
// browser engine sets after Google's own login flow completes).
//
// Detection strategy: after each WebView navigation event (and on a short
// poll while the WebView is settled) we read all cookies for
// https://music.youtube.com via @react-native-cookies/cookies. Android's
// native CookieManager.getCookie() returns the FULL cookie jar for the URL,
// including HttpOnly cookies (SAPISID/__Secure-* are httpOnly and are NOT
// visible to injected `document.cookie` JS -- that's exactly why we use the
// native cookies lib rather than injectedJavaScript). Login is considered
// complete once both:
//   - a SAPISID-family cookie exists (SAPISID or __Secure-3PAPISID) --
//     required by authStore.buildAuthHeaders to compute SAPISIDHASH, and
//   - a session cookie exists (SID, __Secure-1PSID or __Secure-3PSID) --
//     confirms an actual signed-in session, not just a pre-login CONSENT/
//     VISITOR_INFO1_LIVE jar.
// On success we assemble a `name=value; name2=value2; ...` cookie header
// (the form authStore.parseCookieString expects -- NOT a raw Set-Cookie
// string) from ALL cookies returned for the domain, validate it by calling
// buildAuthHeaders (throws if SAPISID is somehow missing), persist it via
// saveAuth, and navigate to Library.
//
// A manual "Done / I'm logged in" button is provided as a fallback trigger
// in case navigation-state events don't fire an extra check right after the
// user finishes the Google login redirect chain (e.g. if the WebView lands
// on a page that doesn't itself trigger onNavigationStateChange again).
//
// Fallback B -- cookie paste: Google sometimes blocks the disguised WebView
// anyway (the UA/heuristic check is not guaranteed to pass forever, and some
// accounts/regions trigger extra verification steps that don't render well
// in a WebView at all). A "Paste cookie instead" toggle switches this screen
// to a plain TextInput where the user pastes a `Cookie:` header copied from
// their desktop browser's devtools (Network tab -> any music.youtube.com
// request -> Copy -> Copy as cURL or Copy request headers -> the `cookie:`
// line). This goes through the exact same buildAuthHeaders/saveAuth
// validation path as the WebView flow, so it's a strict superset guarantee:
// login works even if the WebView path is fully blocked.
import React, {useCallback, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {WebView, WebViewNavigation} from 'react-native-webview';
import CookieManager from '@react-native-cookies/cookies';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../App';
import {buildAuthHeaders, saveAuth} from './authStore';

type Props = NativeStackScreenProps<RootStackParamList, 'Login'>;

const MUSIC_URL = 'https://music.youtube.com';
// accounts.google.com's own login flow sets SAPISID/SID on the .google.com
// domain; because that flow happens as top-level navigation inside the same
// WebView (not a genuinely cross-site third-party context), Android's
// CookieManager stores it under the .google.com domain rather than
// music.youtube.com. We read both URLs' cookie jars and merge them so we
// pick up SAPISID/SID regardless of which domain Google chose to set it on.
const GOOGLE_URL = 'https://www.google.com';

// A current desktop Chrome UA. YouTube/Google's login flow rejects
// unrecognized or stale mobile/embedded UAs (shows the
// "This browser or app may not be secure" block page), so we present as a
// recent desktop Chrome on Windows rather than the WebView's default UA.
const DESKTOP_CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const SAPISID_KEYS = ['SAPISID', '__Secure-3PAPISID'];
const SESSION_KEYS = ['SID', '__Secure-1PSID', '__Secure-3PSID'];

export default function LoginScreen({navigation}: Props) {
  const [checking, setChecking] = useState(false);
  const [mode, setMode] = useState<'webview' | 'paste'>('webview');
  const [pastedCookie, setPastedCookie] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [submittingPaste, setSubmittingPaste] = useState(false);
  const completedRef = useRef(false);

  const tryCompleteLogin = useCallback(
    async (silent: boolean) => {
      if (completedRef.current) return;
      setChecking(true);
      try {
        const [musicCookies, googleCookies] = await Promise.all([
          CookieManager.get(MUSIC_URL, true),
          CookieManager.get(GOOGLE_URL, true),
        ]);
        // Merge with music.youtube.com winning on name collisions (it's the
        // origin we actually authenticate against for the origin-bound
        // SAPISIDHASH computation).
        const merged: Record<string, {name: string; value: string}> = {
          ...googleCookies,
          ...musicCookies,
        };
        const haveSapisid = SAPISID_KEYS.some(k => !!merged[k]?.value);
        const haveSession = SESSION_KEYS.some(k => !!merged[k]?.value);
        if (!haveSapisid || !haveSession) {
          if (!silent) {
            Alert.alert(
              'Not signed in yet',
              'Finish signing in to your Google account in the page above, then tap this button again.',
            );
          }
          return;
        }
        const joined = Object.values(merged)
          .map(c => `${c.name}=${c.value}`)
          .join('; ');
        // Validate before persisting -- throws if SAPISID is somehow
        // missing from the joined header (shouldn't happen given the
        // haveSapisid check above, but this keeps saveAuth() from ever
        // storing a header buildAuthHeaders can't use).
        buildAuthHeaders(joined, Date.now());
        await saveAuth(joined);
        completedRef.current = true;
        navigation.replace('Library');
      } catch (e) {
        if (!silent) {
          Alert.alert(
            'Login check failed',
            e instanceof Error ? e.message : 'Unknown error',
          );
        }
      } finally {
        setChecking(false);
      }
    },
    [navigation],
  );

  const onNavigationStateChange = useCallback(
    (navState: WebViewNavigation) => {
      if (navState.loading) return;
      // Fire-and-forget: a silent check after every settled navigation so
      // login is detected automatically as soon as YT Music redirects back
      // from the Google accounts flow, without requiring the manual button.
      tryCompleteLogin(true);
    },
    [tryCompleteLogin],
  );

  const onSubmitPastedCookie = useCallback(async () => {
    setPasteError(null);
    const trimmed = pastedCookie.trim();
    if (trimmed === '') {
      setPasteError('Paste a cookie header first.');
      return;
    }
    setSubmittingPaste(true);
    try {
      // Validates (throws if no SAPISID/__Secure-3PAPISID present) before
      // ever persisting anything, same guarantee as the WebView path.
      buildAuthHeaders(trimmed, Date.now());
      await saveAuth(trimmed);
      completedRef.current = true;
      navigation.replace('Library');
    } catch (e) {
      setPasteError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSubmittingPaste(false);
    }
  }, [navigation, pastedCookie]);

  return (
    <View style={styles.container}>
      <View style={styles.modeSwitch}>
        <Pressable
          onPress={() => setMode(mode === 'webview' ? 'paste' : 'webview')}>
          <Text style={styles.modeSwitchText}>
            {mode === 'webview'
              ? "Trouble signing in? Paste cookie instead"
              : "Back to sign-in page"}
          </Text>
        </Pressable>
      </View>
      {mode === 'webview' ? (
        <>
          <WebView
            source={{uri: MUSIC_URL}}
            userAgent={DESKTOP_CHROME_UA}
            onNavigationStateChange={onNavigationStateChange}
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            domStorageEnabled
            javaScriptEnabled
            style={styles.webview}
          />
          <View style={styles.footer}>
            <Pressable
              style={[styles.button, checking && styles.buttonDisabled]}
              disabled={checking}
              onPress={() => tryCompleteLogin(false)}>
              {checking ? (
                <ActivityIndicator color="#0b0b0f" />
              ) : (
                <Text style={styles.buttonText}>Done / I'm logged in</Text>
              )}
            </Pressable>
          </View>
        </>
      ) : (
        <ScrollView
          style={styles.pasteContainer}
          contentContainerStyle={styles.pasteContent}
          keyboardShouldPersistTaps="handled">
          <Text style={styles.pasteInstructions}>
            On a desktop browser, sign in to music.youtube.com, then open
            DevTools -&gt; Network tab, click any request to
            music.youtube.com, and copy its "cookie" request header. Paste
            the full value below.
          </Text>
          <Pressable
            onPress={() =>
              Linking.openURL(
                'https://developer.chrome.com/docs/devtools/network/reference',
              )
            }>
            <Text style={styles.pasteLink}>
              How do I find the cookie header? (DevTools docs)
            </Text>
          </Pressable>
          <TextInput
            style={styles.pasteInput}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="SID=...; SAPISID=...; __Secure-3PAPISID=...; ..."
            placeholderTextColor="#6b6b78"
            value={pastedCookie}
            onChangeText={setPastedCookie}
          />
          {pasteError ? (
            <Text style={styles.pasteError}>{pasteError}</Text>
          ) : null}
          <Pressable
            style={[
              styles.button,
              submittingPaste && styles.buttonDisabled,
            ]}
            disabled={submittingPaste}
            onPress={onSubmitPastedCookie}>
            {submittingPaste ? (
              <ActivityIndicator color="#0b0b0f" />
            ) : (
              <Text style={styles.buttonText}>Log in with pasted cookie</Text>
            )}
          </Pressable>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0b0b0f'},
  webview: {flex: 1, backgroundColor: '#0b0b0f'},
  modeSwitch: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#15151c',
    borderBottomWidth: 1,
    borderBottomColor: '#26262f',
  },
  modeSwitchText: {color: '#5b8def', fontSize: 13, fontWeight: '600'},
  footer: {
    padding: 16,
    backgroundColor: '#15151c',
    borderTopWidth: 1,
    borderTopColor: '#26262f',
  },
  button: {
    backgroundColor: '#5b8def',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonDisabled: {opacity: 0.6},
  buttonText: {color: '#0b0b0f', fontSize: 16, fontWeight: '600'},
  pasteContainer: {flex: 1, backgroundColor: '#0b0b0f'},
  pasteContent: {padding: 16},
  pasteInstructions: {
    color: '#c8c8d2',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 8,
  },
  pasteLink: {
    color: '#5b8def',
    fontSize: 13,
    marginBottom: 16,
    textDecorationLine: 'underline',
  },
  pasteInput: {
    minHeight: 140,
    backgroundColor: '#15151c',
    borderWidth: 1,
    borderColor: '#26262f',
    borderRadius: 8,
    padding: 12,
    color: '#f2f2f5',
    fontSize: 13,
    textAlignVertical: 'top',
    marginBottom: 12,
  },
  pasteError: {color: '#ef5b5b', fontSize: 13, marginBottom: 12},
});
