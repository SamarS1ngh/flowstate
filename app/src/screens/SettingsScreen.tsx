import React, {useCallback, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as RNFS from '@dr.pogodin/react-native-fs';
import {pick, keepLocalCopy, types} from '@react-native-documents/picker';
import {useFocusEffect} from '@react-navigation/native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../App';
import {importVibesDb} from '../db/vibesDb';
import {clearAuth, clearOAuthCreds, loadOAuthCreds} from '../auth/authStore';
import {colors, radii, spacing, type} from '../ui/theme';
import {analyzeEmbeddingAndMoods} from '../analyze/tflite';
import {
  isAutoAnalyzeEnabled,
  setAutoAnalyzeEnabled,
  isAnalyzeWifiOnly,
  setAnalyzeWifiOnly,
  isAnalyzePauseLowBattery,
  setAnalyzePauseLowBattery,
} from '../analyze/analyzer';
import {
  runMelFixtureParity,
  runRealSongDecodeSanity,
  runRealSongPathParityProbe,
  type RealSongPathParityEntry,
} from '../analyze/melParityHarness';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

export default function SettingsScreen({navigation}: Props) {
  const [importingFile, setImportingFile] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [tfliteProbing, setTfliteProbing] = useState(false);
  const [melParityRunning, setMelParityRunning] = useState(false);
  const [realSongProbing, setRealSongProbing] = useState(false);
  const [realSongPathParityRunning, setRealSongPathParityRunning] = useState(false);
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const [wifiOnly, setWifiOnly] = useState(true);
  const [pauseLowBattery, setPauseLowBattery] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void isAutoAnalyzeEnabled().then(v => {
        if (!cancelled) setAutoAnalyze(v);
      });
      void isAnalyzeWifiOnly().then(v => {
        if (!cancelled) setWifiOnly(v);
      });
      void isAnalyzePauseLowBattery().then(v => {
        if (!cancelled) setPauseLowBattery(v);
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const onToggleAutoAnalyze = (v: boolean) => {
    setAutoAnalyze(v); // optimistic
    void setAutoAnalyzeEnabled(v);
  };

  const onToggleWifiOnly = (v: boolean) => {
    setWifiOnly(v);
    void setAnalyzeWifiOnly(v);
  };

  const onTogglePauseLowBattery = (v: boolean) => {
    setPauseLowBattery(v);
    void setAnalyzePauseLowBattery(v);
  };

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        // OAuth device-flow credentials (flowstate.oauth.v1) are the
        // source of truth for login state now; the cookie-paste fallback
        // (flowstate.auth.v1, still cleared below on logout) is a hidden
        // secondary path and doesn't drive this row's display.
        const creds = await loadOAuthCreds();
        if (!cancelled) {
          setLoggedIn(creds != null);
          setAuthChecked(true);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const onLogout = async () => {
    setLoggingOut(true);
    try {
      await clearOAuthCreds();
      await clearAuth();
      setLoggedIn(false);
      Alert.alert('Logged out', 'You have been signed out of YouTube Music.');
    } catch (e) {
      Alert.alert(
        'Logout failed',
        e instanceof Error ? e.message : 'Unknown error',
      );
    } finally {
      setLoggingOut(false);
    }
  };
  // No baked-in default IP -- every user's LAN address is different, so a
  // hardcoded value here would either be silently wrong (most users) or, if
  // ever left untouched, quietly point the app at someone else's machine.
  // An empty field plus placeholder text (below) forces the user to enter
  // their own analyzer address.
  const [syncUrl, setSyncUrl] = useState('');

  const onImportFromFile = async () => {
    setImportingFile(true);
    try {
      const [picked] = await pick({type: types.allFiles});
      // The installed @react-native-documents/picker (v12) has no
      // `pickSingle({copyTo})` shortcut like the brief's react-native-document-picker
      // API. Instead `pick()` returns a content:// (Android) URI that must be
      // materialized into a real local file via `keepLocalCopy()` before it can
      // be handed to importVibesDb (which shells out to RNFS.copyFile on a
      // plain path).
      const [copy] = await keepLocalCopy({
        files: [{uri: picked.uri, fileName: picked.name ?? 'vibes.db'}],
        destination: 'cachesDirectory',
      });
      if (copy.status === 'error') {
        throw new Error(copy.copyError);
      }
      await importVibesDb(copy.localUri);
      Alert.alert('Import complete', 'Analysis data imported successfully.', [
        {text: 'OK', onPress: () => navigation.navigate('Library')},
      ]);
    } catch (e: any) {
      if (e?.code === 'OPERATION_CANCELED') {
        // user backed out of the picker; not an error
        return;
      }
      Alert.alert(
        'Import failed',
        e instanceof Error ? e.message : 'Unknown error',
      );
    } finally {
      setImportingFile(false);
    }
  };

  const onSyncFromWifi = async () => {
    const url = syncUrl.trim();
    if (!url) {
      Alert.alert('Sync failed', 'Enter a URL first.');
      return;
    }
    setSyncing(true);
    try {
      const dest = `${RNFS.CachesDirectoryPath}/vibes-sync.db`;
      const {promise} = RNFS.downloadFile({fromUrl: url, toFile: dest});
      const result = await promise;
      if (result.statusCode !== 200) {
        throw new Error(`Server responded with status ${result.statusCode}`);
      }
      await importVibesDb(dest);
      Alert.alert('Import complete', 'Analysis data imported successfully.', [
        {text: 'OK', onPress: () => navigation.navigate('Library')},
      ]);
    } catch (e) {
      Alert.alert(
        'Sync failed',
        e instanceof Error ? e.message : 'Unknown error',
      );
    } finally {
      setSyncing(false);
    }
  };

  // Task 4 on-device sanity probe (Plan D Phase 2): proves react-native-fast-tflite
  // actually loads the bundled embedding + mood-head models and runs them on
  // a real phone, without depending on Task 5's mel pipeline. Feeds a FIXED
  // synthetic ramp patch (not all-zeros, so a degenerate all-zero-output bug
  // would be visible) through loadModels() + runEmbedding()/runMoods() and
  // reports the embedding's shape + a couple of mood scores. __DEV__-gated:
  // never rendered in a release build. Real inference correctness (vs the
  // essentia reference) is verified on-device in Task 5, not here.
  const onRunTfliteProbe = async () => {
    setTfliteProbing(true);
    try {
      const patch = new Float32Array(187 * 96);
      for (let i = 0; i < patch.length; i++) {
        patch[i] = (i % 97) / 97;
      }
      const start = Date.now();
      const {embedding, moods} = await analyzeEmbeddingAndMoods([patch]);
      const elapsedMs = Date.now() - start;
      console.log('[tflite probe] embedding length', embedding.length);
      console.log('[tflite probe] moods', moods);
      console.log('[tflite probe] elapsed ms', elapsedMs);
      Alert.alert(
        'TFLite probe OK',
        `embedding: float32[${embedding.length}]\n` +
          `happy=${moods.happy.toFixed(3)} sad=${moods.sad.toFixed(3)}\n` +
          `${elapsedMs}ms`,
      );
    } catch (e) {
      console.log('[tflite probe] FAILED', e);
      Alert.alert(
        'TFLite probe failed',
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setTfliteProbing(false);
    }
  };

  // Task 5 THE PROOF (Plan D Phase 2): runs every golden fixture's PCM
  // (pushed to the device -- see melParityHarness.ts's doc comment for the
  // adb commands) through the native Kotlin mel port -> bundled TFLite
  // embedding model, and compares each result to essentia's own embedding
  // for that clip via cosine similarity. REQUIRES min cosine >= 0.99 across
  // every fixture. __DEV__-gated; never shown in a release build.
  const onRunMelParity = async () => {
    setMelParityRunning(true);
    try {
      const {results, minCosine} = await runMelFixtureParity((clip, i, total) => {
        console.log(`[mel parity] (${i + 1}/${total}) running ${clip}...`);
      });
      for (const r of results) {
        console.log(`[mel parity] ${r.clip}: cosine=${r.cosine.toFixed(6)} (${r.numPatches} patches)`);
      }
      console.log(`[mel parity] MIN COSINE = ${minCosine.toFixed(6)} (gate: >= 0.99)`);
      const lines = results.map(r => `${r.clip}: ${r.cosine.toFixed(4)}`).join('\n');
      Alert.alert(
        minCosine >= 0.99 ? 'Mel parity PASSED' : 'Mel parity FAILED',
        `min cosine = ${minCosine.toFixed(6)}\n\n${lines}`,
      );
    } catch (e) {
      console.log('[mel parity] FAILED', e);
      Alert.alert('Mel parity probe failed', e instanceof Error ? e.message : String(e));
    } finally {
      setMelParityRunning(false);
    }
  };

  // Sanity-checks the PRODUCTION decode path (decodeToPcm's MediaCodec
  // decode + resample + middle-120s-slice) end-to-end on a real downloaded
  // song from the synced library. No essentia reference for this clip --
  // only checks the pipeline runs and produces non-degenerate output.
  const onRunRealSongSanity = async () => {
    setRealSongProbing(true);
    try {
      const result = await runRealSongDecodeSanity();
      console.log('[real song sanity]', result);
      Alert.alert(
        'Real-song decode sanity OK',
        `videoId=${result.videoId}\npatches=${result.numPatches}\n` +
          `embedding norm=${result.embeddingNorm.toFixed(3)}\n` +
          `happy=${result.moods.happy.toFixed(3)} sad=${result.moods.sad.toFixed(3)}`,
      );
    } catch (e) {
      console.log('[real song sanity] FAILED', e);
      Alert.alert('Real-song decode sanity failed', e instanceof Error ? e.message : String(e));
    } finally {
      setRealSongProbing(false);
    }
  };

  // TEMP (real-song end-to-end parity measurement -- see
  // .superpowers/sdd/real-song-parity-report.md): files pre-pushed via
  // `adb push <file> ${realSongProbeDir()}/<fileName>` (app's own external
  // files dir, no run-as needed). Filled in per measurement run; left empty
  // otherwise so the button below is a no-op with nothing pushed.
  // Fill in {videoId, fileName} for files pre-pushed to realSongProbeDir()
  // (adb push <file> /sdcard/Android/data/com.flowstate/files/flowstate_probe/)
  // then compare results.json against essentia refs from
  // analyzer/parity_ref.py. Left empty in source; populated ad hoc when
  // running the real-song end-to-end parity check. See
  // .superpowers/sdd/real-song-parity-report.md.
  const REAL_SONG_PATH_PARITY_ENTRIES: RealSongPathParityEntry[] = [];

  const onRunRealSongPathParity = async () => {
    setRealSongPathParityRunning(true);
    try {
      const results = await runRealSongPathParityProbe(REAL_SONG_PATH_PARITY_ENTRIES, (videoId, i, total) => {
        console.log(`[real song path parity] (${i + 1}/${total}) running ${videoId}...`);
      });
      for (const r of results) {
        console.log(`[real song path parity] ${r.videoId}: ${r.numPatches} patches, embedding logged`);
      }
      Alert.alert(
        'Real-song path parity done',
        `${results.length}/${REAL_SONG_PATH_PARITY_ENTRIES.length} songs processed.\nResults written to realSongProbeDir()/results.json`,
      );
    } catch (e) {
      console.log('[real song path parity] FAILED', e);
      Alert.alert('Real-song path parity failed', e instanceof Error ? e.message : String(e));
    } finally {
      setRealSongPathParityRunning(false);
    }
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}>
      <View style={styles.section}>
        <View style={styles.toggleRow}>
          <View style={styles.toggleTextCol}>
            <Text style={styles.sectionTitle}>Auto-analyze library</Text>
            <Text style={styles.toggleDesc}>
              Analyze your songs in the background so vibe shuffle works. Runs once per
              song (shared across playlists) and keeps going when the app is closed.
            </Text>
          </View>
          <Switch
            value={autoAnalyze}
            onValueChange={onToggleAutoAnalyze}
            trackColor={{true: colors.accent, false: colors.surfaceRaised}}
          />
        </View>
        <View style={[styles.toggleRow, {marginTop: spacing.lg}]}>
          <View style={styles.toggleTextCol}>
            <Text style={styles.sectionTitle}>Analyze on Wi-Fi only</Text>
            <Text style={styles.toggleDesc}>
              Analysis downloads audio. Keep this on to avoid using mobile data — it
              pauses on cellular and resumes on Wi-Fi.
            </Text>
          </View>
          <Switch
            value={wifiOnly}
            onValueChange={onToggleWifiOnly}
            trackColor={{true: colors.accent, false: colors.surfaceRaised}}
          />
        </View>
        <View style={[styles.toggleRow, {marginTop: spacing.lg}]}>
          <View style={styles.toggleTextCol}>
            <Text style={styles.sectionTitle}>Pause on low battery</Text>
            <Text style={styles.toggleDesc}>
              Analysis is CPU-heavy. Keep this on to pause below 20% when unplugged
              — it resumes automatically once charging or recharged.
            </Text>
          </View>
          <Switch
            value={pauseLowBattery}
            onValueChange={onTogglePauseLowBattery}
            trackColor={{true: colors.accent, false: colors.surfaceRaised}}
          />
        </View>
      </View>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>YouTube Music account</Text>
        {!authChecked ? (
          <ActivityIndicator color={colors.accent} />
        ) : loggedIn ? (
          <>
            <Text style={styles.sectionBody}>Logged in ✓</Text>
            <Pressable
              style={[styles.button, styles.buttonSecondary, loggingOut && styles.buttonDisabled]}
              disabled={loggingOut}
              onPress={onLogout}>
              {loggingOut ? (
                <ActivityIndicator color={colors.textPrimary} />
              ) : (
                <Text style={styles.buttonSecondaryText}>Logout</Text>
              )}
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.sectionBody}>
              Log in to sync your playlists and play login-gated songs.
            </Text>
            <Pressable
              style={styles.button}
              onPress={() => navigation.navigate('Login')}>
              <Text style={styles.buttonText}>Log in to YouTube Music</Text>
            </Pressable>
          </>
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Import analysis data from file</Text>
        <Text style={styles.sectionBody}>
          Pick an analyzer vibes.db file from device storage or a cloud
          provider. Playlists and songs come from your synced YouTube Music
          account above -- this only adds vibe analysis (mood/similarity
          data) on top of songs that are already in your library.
        </Text>
        <Pressable
          style={[styles.button, styles.buttonSecondary, importingFile && styles.buttonDisabled]}
          disabled={importingFile}
          onPress={onImportFromFile}>
          {importingFile ? (
            <ActivityIndicator color={colors.textPrimary} />
          ) : (
            <Text style={styles.buttonSecondaryText}>Choose file</Text>
          )}
        </Pressable>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>
          Import analysis data from PC over wifi
        </Text>
        <Text style={styles.sectionBody}>
          Enter the URL shown by the analyzer's `serve` command running on
          your PC. Same as above -- adds vibe analysis on top of your synced
          library, doesn't replace it.
        </Text>
        <TextInput
          style={styles.input}
          value={syncUrl}
          onChangeText={setSyncUrl}
          placeholder="http://192.168.0.X:8765/vibes.db"
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Pressable
          style={[styles.button, styles.buttonSecondary, syncing && styles.buttonDisabled]}
          disabled={syncing}
          onPress={onSyncFromWifi}>
          {syncing ? (
            <ActivityIndicator color={colors.textPrimary} />
          ) : (
            <Text style={styles.buttonSecondaryText}>Sync now</Text>
          )}
        </Pressable>
      </View>

      {__DEV__ && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>TFLite probe (dev only)</Text>
          <Text style={styles.sectionBody}>
            Runs a fixed synthetic patch through the bundled embedding + mood
            models to confirm react-native-fast-tflite loads and runs
            on-device (Plan D Task 4). Not shown in release builds.
          </Text>
          <Pressable
            style={[styles.button, styles.buttonSecondary, tfliteProbing && styles.buttonDisabled]}
            disabled={tfliteProbing}
            onPress={onRunTfliteProbe}>
            {tfliteProbing ? (
              <ActivityIndicator color={colors.textPrimary} />
            ) : (
              <Text style={styles.buttonSecondaryText}>Run TFLite probe</Text>
            )}
          </Pressable>
        </View>
      )}

      {__DEV__ && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Mel parity probe (dev only)</Text>
          <Text style={styles.sectionBody}>
            THE Plan D Task 5 proof: runs the native Kotlin mel port on every
            golden fixture's PCM and compares its TFLite embedding to
            essentia's via cosine similarity (gate: min cosine {'>='} 0.99).
            Requires the fixture files pushed to the device first. Not shown
            in release builds.
          </Text>
          <Pressable
            style={[styles.button, styles.buttonSecondary, melParityRunning && styles.buttonDisabled]}
            disabled={melParityRunning}
            onPress={onRunMelParity}>
            {melParityRunning ? (
              <ActivityIndicator color={colors.textPrimary} />
            ) : (
              <Text style={styles.buttonSecondaryText}>Run mel fixtures parity</Text>
            )}
          </Pressable>
        </View>
      )}

      {__DEV__ && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Real-song decode sanity (dev only)</Text>
          <Text style={styles.sectionBody}>
            Resolves + downloads the first synced song, runs the full
            production decode path (MediaCodec -{'>'} mel -{'>'} embedding +
            moods) end to end. No essentia reference for this clip -- sanity
            only. Not shown in release builds.
          </Text>
          <Pressable
            style={[styles.button, styles.buttonSecondary, realSongProbing && styles.buttonDisabled]}
            disabled={realSongProbing}
            onPress={onRunRealSongSanity}>
            {realSongProbing ? (
              <ActivityIndicator color={colors.textPrimary} />
            ) : (
              <Text style={styles.buttonSecondaryText}>Run real-song decode sanity</Text>
            )}
          </Pressable>
        </View>
      )}
      {__DEV__ && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Real-song path parity (dev only, TEMP)</Text>
          <Text style={styles.sectionBody}>
            Runs the full production decode path on real audio files pre-pushed to
            realSongProbeDir(), writing pooled embeddings to results.json for comparison
            against an essentia reference computed on the identical file. Not shown in
            release builds.
          </Text>
          <Pressable
            style={[styles.button, styles.buttonSecondary, realSongPathParityRunning && styles.buttonDisabled]}
            disabled={realSongPathParityRunning}
            onPress={onRunRealSongPathParity}>
            {realSongPathParityRunning ? (
              <ActivityIndicator color={colors.textPrimary} />
            ) : (
              <Text style={styles.buttonSecondaryText}>Run real-song path parity</Text>
            )}
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.bg},
  content: {padding: spacing.lg, paddingBottom: spacing.xxxl},
  section: {
    marginBottom: spacing.xl,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.lg,
  },
  sectionTitle: {...type.headline, marginBottom: spacing.xs},
  sectionBody: {color: colors.textSecondary, fontSize: 14, marginBottom: spacing.lg, lineHeight: 20},
  toggleRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  toggleTextCol: {flex: 1, paddingRight: spacing.lg},
  toggleDesc: {color: colors.textSecondary, fontSize: 13, lineHeight: 18},
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    color: colors.textPrimary,
    fontSize: 15,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md - 2,
    marginBottom: spacing.md,
    backgroundColor: colors.surfaceRaised,
  },
  button: {
    backgroundColor: colors.white,
    paddingVertical: spacing.md,
    borderRadius: radii.pill,
    alignItems: 'center',
  },
  buttonSecondary: {backgroundColor: colors.chipBg},
  buttonDisabled: {opacity: 0.6},
  buttonText: {color: colors.black, fontSize: 16, fontWeight: '700'},
  buttonSecondaryText: {color: colors.textPrimary, fontSize: 16, fontWeight: '700'},
});
