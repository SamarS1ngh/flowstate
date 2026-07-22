import React, {useEffect, useState} from 'react';
import {PermissionsAndroid, Platform} from 'react-native';
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
      await requestNotificationPermission();
      await TrackPlayer.setupPlayer();
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
      setReady(true);
    })();
  }, []);

  if (!ready) return null;
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
