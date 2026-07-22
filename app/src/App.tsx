import React, {useEffect, useState} from 'react';
import {PermissionsAndroid, Platform, StyleSheet, Text, View} from 'react-native';
import {DarkTheme, NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import TrackPlayer, {
  Capability,
  AppKilledPlaybackBehavior,
} from 'react-native-track-player';
import LibraryScreen from './screens/LibraryScreen';
import PlaylistScreen from './screens/PlaylistScreen';
import PlayerScreen from './screens/PlayerScreen';
import SettingsScreen from './screens/SettingsScreen';
import {openVibesDb} from './db/vibesDb';
import {FeedbackStore} from './engine/feedbackStore';

export type RootStackParamList = {
  Library: undefined;
  Playlist: {playlistId: string | 'ALL'; playlistName: string};
  Player: undefined;
  Settings: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: '#5b8def',
    background: '#0b0b0f',
    card: '#15151c',
    text: '#f2f2f5',
    border: '#26262f',
    notification: '#5b8def',
  },
};

// react-native-track-player's native module rejects setupPlayer() with this
// code (Android: MusicModule.kt's "player_already_initialized") once a
// player already exists -- which happens whenever the host Activity is
// recreated (rotation, low-memory recreation, returning from another app)
// while the playback service has kept the process (and its already-set-up
// player) alive. That's an expected, recoverable state, not a bootstrap
// failure, so it's matched defensively on both code and message text (in
// case of platform/version differences) and treated as success.
function isPlayerAlreadyInitializedError(e: unknown): boolean {
  const code = (e as any)?.code;
  const message = String((e as any)?.message ?? e ?? '');
  return (
    code === 'player_already_initialized' ||
    /already.*(initializ|set ?up)/i.test(message)
  );
}

async function requestNotificationPermission(): Promise<void> {
  // Android 13+ (API 33) requires runtime grant for the foreground-service
  // playback notification; RNTP's bundled manifest does not declare it.
  if (Platform.OS !== 'android' || Platform.Version < 33) return;
  try {
    await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );
  } catch {
    // Non-fatal: playback still works, just without a visible notification.
  }
}

export default function App() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      // Bootstrap must never leave the app stuck rendering null forever.
      // Anything below can throw (setupPlayer() rejects with
      // player_already_initialized on activity recreation while the
      // playback service keeps the process alive; openVibesDb() can throw
      // on a corrupt vibes.db) -- in every case except the expected
      // already-initialized one, we log and still boot, in degraded mode
      // if need be, rather than brick the app on a blank screen.
      try {
        await requestNotificationPermission();
        try {
          await TrackPlayer.setupPlayer();
        } catch (e) {
          if (!isPlayerAlreadyInitializedError(e)) throw e;
          // Player is already up from a previous mount of this process --
          // nothing to do, fall through as if setupPlayer() had succeeded.
        }
        await TrackPlayer.updateOptions({
          android: {
            appKilledPlaybackBehavior:
              AppKilledPlaybackBehavior.ContinuePlayback,
          },
          capabilities: [
            Capability.Play,
            Capability.Pause,
            Capability.SkipToNext,
            Capability.SkipToPrevious,
            Capability.SeekTo,
          ],
          compactCapabilities: [
            Capability.Play,
            Capability.Pause,
            Capability.SkipToNext,
          ],
        });
        // Feedback tables live inside vibes.db itself, so they can only be
        // created once a db has actually been imported. If the user imports
        // vibes.db for the first time after this bootstrap already ran (no
        // app restart), PlaylistScreen/PlayerScreen defensively call
        // ensureTables() again themselves before touching FeedbackStore --
        // it's an idempotent CREATE TABLE IF NOT EXISTS, so calling it twice
        // is harmless.
        const db = await openVibesDb();
        if (db) new FeedbackStore(db.handle).ensureTables();
      } catch (e) {
        // Anything else (corrupt vibes.db, updateOptions failure, an
        // unexpected setupPlayer rejection, ...) is non-fatal to boot: the
        // app must still render so degraded features can surface in-screen
        // (e.g. Library/Playlist already handle a null/empty db gracefully).
        console.warn('App bootstrap encountered an error; booting in degraded mode', e);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  if (!ready) {
    // Minimal dark splash instead of a blank/null render while bootstrap
    // runs, so an activity-recreation stall or a slow db open never looks
    // like a crash.
    return (
      <View style={styles.splash}>
        <Text style={styles.splashText}>flowstate</Text>
      </View>
    );
  }
  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator
        screenOptions={{
          headerStyle: {backgroundColor: '#15151c'},
          headerTintColor: '#f2f2f5',
          contentStyle: {backgroundColor: '#0b0b0f'},
        }}>
        <Stack.Screen name="Library" component={LibraryScreen} />
        <Stack.Screen
          name="Playlist"
          component={PlaylistScreen}
          options={({route}) => ({
            title: route.params?.playlistName ?? 'Playlist',
          })}
        />
        <Stack.Screen name="Player" component={PlayerScreen} />
        <Stack.Screen name="Settings" component={SettingsScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: '#0b0b0f',
    alignItems: 'center',
    justifyContent: 'center',
  },
  splashText: {
    color: '#f2f2f5',
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: 1,
  },
});
