import React, {useCallback, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
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

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

export default function SettingsScreen({navigation}: Props) {
  const [importingFile, setImportingFile] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

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

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}>
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
