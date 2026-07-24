import React, {useCallback, useEffect, useRef, useState} from 'react';
import {PermissionsAndroid, Platform, StyleSheet, Text, View} from 'react-native';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {
  createNavigationContainerRef,
  DarkTheme,
  NavigationContainer,
} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import TrackPlayer, {
  Capability,
  AppKilledPlaybackBehavior,
} from 'react-native-track-player';
import LibraryScreen from './screens/LibraryScreen';
import PlaylistScreen from './screens/PlaylistScreen';
import PlayerScreen from './screens/PlayerScreen';
import SettingsScreen from './screens/SettingsScreen';
import LoginScreen from './auth/LoginScreen';
import {openVibesDb} from './db/vibesDb';
import {FeedbackStore} from './engine/feedbackStore';
import BottomNav, {BottomNavKey} from './ui/BottomNav';
import MiniPlayer from './ui/MiniPlayer';
import {colors} from './ui/theme';

export type RootStackParamList = {
  Library: undefined;
  Playlist: {playlistId: string | 'ALL'; playlistName: string};
  Player: undefined;
  Settings: undefined;
  Login: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

const navigationRef = createNavigationContainerRef<RootStackParamList>();

// Routes where the persistent mini player / bottom nav shell (Task 3) should
// NOT show: Player is the full now-playing screen the mini player expands
// into (showing both would be redundant and would eat vertical space from
// the transport row), and Login is a focused auth flow that shouldn't
// suggest "you can navigate away, the tabs are still here".
const SHELL_HIDDEN_ROUTES = new Set<keyof RootStackParamList>(['Player', 'Login']);

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.accent,
    background: colors.bg,
    card: colors.bg,
    text: colors.textPrimary,
    border: colors.border,
    notification: colors.accent,
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
    // Required root wrapper for react-native-gesture-handler (PlayerScreen's
    // pull-down-to-dismiss / swipe-to-skip gestures) -- must wrap everything
    // that uses gesture-handler, so it sits at the very top, outside even
    // SafeAreaProvider/NavigationContainer.
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <AppShell />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

// Persistent mini-player + bottom-nav shell (Task 3): mounted once here,
// alongside the Stack.Navigator rather than inside any individual screen,
// so it survives Library <-> Playlist navigation and only disappears on the
// routes in SHELL_HIDDEN_ROUTES. Split out from App() so it can call
// useSafeAreaInsets(), which requires being inside SafeAreaProvider.
function AppShell() {
  const insets = useSafeAreaInsets();
  // Root screen is 'Library', so that's the correct initial value for the
  // brief window between first render and NavigationContainer's first
  // onStateChange call.
  const [routeName, setRouteName] =
    useState<keyof RootStackParamList>('Library');

  const onNavStateChange = useCallback(() => {
    if (!navigationRef.isReady()) return;
    const name = navigationRef.getCurrentRoute()?.name;
    if (name) setRouteName(name as keyof RootStackParamList);
  }, []);

  const navigateTab = useCallback((key: BottomNavKey) => {
    if (navigationRef.isReady()) navigationRef.navigate(key);
  }, []);

  const openPlayer = useCallback(() => {
    if (navigationRef.isReady()) navigationRef.navigate('Player');
  }, []);

  const showShell = !SHELL_HIDDEN_ROUTES.has(routeName);
  // Only two real tab destinations exist (see BottomNav) -- every other
  // route (Playlist, the pushed detail screen) still counts as "in the
  // Library area" for which tab reads as active.
  const activeTab: BottomNavKey = routeName === 'Settings' ? 'Settings' : 'Library';

  return (
    <NavigationContainer
      ref={navigationRef}
      theme={navTheme}
      onStateChange={onNavStateChange}>
      <View style={styles.root}>
        <Stack.Navigator
          screenOptions={{
            headerStyle: {backgroundColor: colors.bg},
            headerTintColor: colors.textPrimary,
            headerShadowVisible: false,
            contentStyle: {backgroundColor: colors.bg},
          }}>
          <Stack.Screen
            name="Library"
            component={LibraryScreen}
            options={{headerShown: false}}
          />
          <Stack.Screen
            name="Playlist"
            component={PlaylistScreen}
            options={{headerShown: false}}
          />
          <Stack.Screen
            name="Player"
            component={PlayerScreen}
            options={{headerShown: false}}
          />
          <Stack.Screen name="Settings" component={SettingsScreen} />
          <Stack.Screen
            name="Login"
            component={LoginScreen}
            options={{title: 'Log in to YouTube Music'}}
          />
        </Stack.Navigator>
        {showShell ? (
          <View style={{paddingBottom: insets.bottom, backgroundColor: colors.bg}}>
            <MiniPlayer onPress={openPlayer} />
            <BottomNav active={activeTab} onNavigate={navigateTab} />
          </View>
        ) : null}
      </View>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg},
  splash: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  splashText: {
    color: colors.textPrimary,
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: 1,
  },
});
