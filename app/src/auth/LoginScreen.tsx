// In-app YouTube login: the WebView credential-entry flow this screen used
// to show has been replaced with youtubei.js's OAuth device-code ("smart
// TV") flow (see src/auth/oauth.ts for the full rationale and the
// youtubei.js API this wraps). Google blocks the disguised WebView at
// credential entry ("Couldn't sign you in -- browser may not be secure"),
// so this screen never touches Google's login page at all: it shows a
// short code and a URL, the user approves the code on ANY already-signed-in
// browser (phone, laptop, doesn't matter), and youtubei.js's session picks
// up full credentials the moment that approval completes.
//
// Cookie-paste (Task 1's WebView-adjacent fallback) is kept as a hidden
// "Trouble signing in?" link -- it's a strict superset guarantee in case
// device-code sign-in is ever unavailable (e.g. a future policy change),
// even though it's no longer the primary/expected path.
import React, {useCallback, useEffect, useRef, useState} from 'react';
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
// react-native core's Clipboard is deprecated in favor of
// @react-native-clipboard/clipboard, but it's still present and functional
// (a thin TurboModule wrapper) and avoids adding a new native dependency
// just for a "Copy code" button; it only warns once via warnOnce, which is
// harmless here.
// eslint-disable-next-line deprecation/deprecation
import {Clipboard} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../App';
import {buildAuthHeaders, saveAuth} from './authStore';
import {describeAuthError, startDeviceLogin} from './oauth';

type Props = NativeStackScreenProps<RootStackParamList, 'Login'>;

// device-code flows expire (expires_in from the device/code endpoint is
// ~30 minutes as of this writing) -- if nothing has happened by then,
// youtubei.js emits 'auth-error' and startDeviceLogin's promise rejects,
// which is surfaced through the normal error/retry UI below rather than a
// separate timeout path.

type FlowState =
  | {phase: 'starting'}
  | {phase: 'code-ready'; url: string; code: string}
  | {phase: 'success'}
  | {phase: 'error'; message: string};

export default function LoginScreen({navigation}: Props) {
  const [mode, setMode] = useState<'device' | 'paste'>('device');
  const [flow, setFlow] = useState<FlowState>({phase: 'starting'});
  const [copied, setCopied] = useState(false);
  const [pastedCookie, setPastedCookie] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [submittingPaste, setSubmittingPaste] = useState(false);
  // Guards against starting a second concurrent device-code flow -- e.g.
  // React's Strict Mode double-invoking effects in dev, or the user
  // toggling to "paste cookie" and back before the first flow settled.
  const startedRef = useRef(false);
  // Guards against setState after this screen has already navigated away
  // (navigation.replace unmounts it, but the login promise's .then/.catch
  // can still fire after that if it settles right around the same tick).
  const mountedRef = useRef(true);

  const beginDeviceLogin = useCallback(() => {
    startedRef.current = true;
    setFlow({phase: 'starting'});
    setCopied(false);
    startDeviceLogin((url, code) => {
      if (!mountedRef.current) return;
      setFlow({phase: 'code-ready', url, code});
    })
      .then(() => {
        if (!mountedRef.current) return;
        setFlow({phase: 'success'});
        navigation.replace('Library');
      })
      .catch(err => {
        if (!mountedRef.current) return;
        setFlow({phase: 'error', message: describeAuthError(err)});
      });
  }, [navigation]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (mode === 'device' && !startedRef.current) {
      beginDeviceLogin();
    }
  }, [mode, beginDeviceLogin]);

  const onRetry = useCallback(() => {
    startedRef.current = false;
    beginDeviceLogin();
  }, [beginDeviceLogin]);

  const onCopyCode = useCallback(() => {
    if (flow.phase !== 'code-ready') return;
    Clipboard.setString(flow.code);
    setCopied(true);
  }, [flow]);

  const onOpenVerificationUrl = useCallback(() => {
    if (flow.phase !== 'code-ready') return;
    Linking.openURL(flow.url).catch(() => {
      Alert.alert(
        'Could not open browser',
        `Open ${flow.url} manually and enter the code shown.`,
      );
    });
  }, [flow]);

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
      // ever persisting anything, same guarantee as the device-code path.
      buildAuthHeaders(trimmed, Date.now());
      await saveAuth(trimmed);
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
          onPress={() => setMode(mode === 'device' ? 'paste' : 'device')}>
          <Text style={styles.modeSwitchText}>
            {mode === 'device'
              ? 'Trouble signing in? Paste cookie instead'
              : 'Back to sign-in code'}
          </Text>
        </Pressable>
      </View>
      {mode === 'device' ? (
        <ScrollView
          style={styles.deviceContainer}
          contentContainerStyle={styles.deviceContent}>
          <Text style={styles.title}>Sign in with a code</Text>
          <Text style={styles.subtitle}>
            Enter this code at{' '}
            <Text style={styles.subtitleStrong}>google.com/device</Text> on
            any browser where you're already signed in to your Google
            account -- your phone, a laptop, anything.
          </Text>

          {flow.phase === 'starting' && (
            <View style={styles.codeBox}>
              <ActivityIndicator color="#5b8def" />
              <Text style={styles.codePending}>Getting your code…</Text>
            </View>
          )}

          {flow.phase === 'code-ready' && (
            <>
              <View style={styles.codeBox} testID="device-code-box">
                <Text style={styles.code} testID="device-code-text">
                  {flow.code}
                </Text>
                <Text style={styles.url}>{flow.url}</Text>
              </View>
              <Pressable style={styles.button} onPress={onOpenVerificationUrl}>
                <Text style={styles.buttonText}>
                  Open {flow.url.replace('https://', '')}
                </Text>
              </Pressable>
              <Pressable
                style={[styles.button, styles.secondaryButton]}
                onPress={onCopyCode}>
                <Text style={styles.secondaryButtonText}>
                  {copied ? 'Copied!' : 'Copy code'}
                </Text>
              </Pressable>
              <View style={styles.waitingRow}>
                <ActivityIndicator color="#5b8def" size="small" />
                <Text style={styles.waitingText}>
                  Waiting for you to approve on the other device…
                </Text>
              </View>
            </>
          )}

          {flow.phase === 'success' && (
            <View style={styles.codeBox}>
              <Text style={styles.codePending}>Signed in ✓</Text>
            </View>
          )}

          {flow.phase === 'error' && (
            <View style={styles.codeBox}>
              <Text style={styles.errorText}>{flow.message}</Text>
              <Pressable style={styles.button} onPress={onRetry}>
                <Text style={styles.buttonText}>Retry</Text>
              </Pressable>
            </View>
          )}
        </ScrollView>
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
            style={[styles.button, submittingPaste && styles.buttonDisabled]}
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
  modeSwitch: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#15151c',
    borderBottomWidth: 1,
    borderBottomColor: '#26262f',
  },
  modeSwitchText: {color: '#5b8def', fontSize: 13, fontWeight: '600'},
  deviceContainer: {flex: 1, backgroundColor: '#0b0b0f'},
  deviceContent: {padding: 20, alignItems: 'center'},
  title: {
    color: '#f2f2f5',
    fontSize: 22,
    fontWeight: '700',
    marginTop: 12,
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    color: '#9a9aa8',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 24,
  },
  subtitleStrong: {color: '#c8c8d2', fontWeight: '600'},
  codeBox: {
    width: '100%',
    backgroundColor: '#15151c',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#26262f',
    paddingVertical: 28,
    paddingHorizontal: 16,
    alignItems: 'center',
    marginBottom: 16,
  },
  code: {
    color: '#f2f2f5',
    fontSize: 40,
    fontWeight: '800',
    letterSpacing: 4,
    marginBottom: 12,
  },
  url: {color: '#5b8def', fontSize: 16, fontWeight: '600'},
  codePending: {color: '#c8c8d2', fontSize: 15, marginTop: 12},
  errorText: {
    color: '#ef5b5b',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 16,
  },
  waitingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  waitingText: {color: '#9a9aa8', fontSize: 13, marginLeft: 10},
  button: {
    width: '100%',
    backgroundColor: '#5b8def',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 12,
  },
  buttonDisabled: {opacity: 0.6},
  buttonText: {color: '#0b0b0f', fontSize: 16, fontWeight: '600'},
  secondaryButton: {backgroundColor: '#26262f'},
  secondaryButtonText: {color: '#f2f2f5', fontSize: 16, fontWeight: '600'},
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
