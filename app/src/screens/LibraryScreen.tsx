import React, {useCallback, useRef, useState} from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  ActivityIndicator,
} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../App';
import {ensureBaseSchema, openVibesDb, VibesDb} from '../db/vibesDb';
import {loadOAuthCreds} from '../auth/authStore';
import {fetchLibrary} from '../library/syncClient';
import {syncLibraryToDb} from '../library/syncToDb';
import type {Playlist} from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Library'>;

const ALL_SONGS_ID = 'ALL' as const;

function HeaderButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={12}
      style={[styles.headerButton, disabled && styles.headerButtonDisabled]}>
      <Text style={styles.headerButtonText}>{label}</Text>
    </Pressable>
  );
}

// A db that exists on disk (ensureBaseSchema/import both create the file up
// front) but has no songs and no playlists yet is, from the user's point of
// view, exactly as "empty" as no db existing at all -- e.g. a previous sync
// attempt that created the shell schema and then failed/was killed before
// writing any rows. Both cases should trigger the same auto-sync-on-focus
// behavior for a logged-in user, so this is the single definition of
// "empty" everything below checks against.
function isEmptyLibrary(db: VibesDb): boolean {
  return db.getAllSongs().length === 0 && db.getPlaylists().length === 0;
}

export default function LibraryScreen({navigation}: Props) {
  const [loading, setLoading] = useState(true);
  const [db, setDb] = useState<VibesDb | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [allCount, setAllCount] = useState(0);
  const [loggedIn, setLoggedIn] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  // Prevents auto-sync from firing again every time this screen regains
  // focus in the same app session (e.g. navigating Library -> Player ->
  // back) once it has already tried once this mount -- a real failure still
  // surfaces via syncStatus/Alert and the user can retry with the header
  // button, but focus itself shouldn't hammer the network on every back-nav.
  const autoSyncAttemptedRef = useRef(false);
  // Mirrors `db` state so loadFromDb can close the *previous* native
  // connection synchronously when replacing it -- state itself isn't
  // readable synchronously inside a useCallback without going stale.
  const dbRef = useRef<VibesDb | null>(null);
  // Mirrors `syncing` state for the same reason: read synchronously from
  // inside loadFromDb to decide whether a write is in flight, without
  // waiting on a state update or adding `syncing` to loadFromDb's deps.
  const syncingRef = useRef(false);

  // Swaps in a freshly-opened VibesDb (or null) as the current one, closing
  // whatever connection was open before it so each focus/sync doesn't leak
  // a native op-sqlite handle.
  const applyDb = useCallback((opened: VibesDb | null) => {
    const previous = dbRef.current;
    dbRef.current = opened;
    setDb(opened);
    if (previous && previous !== opened) {
      previous.close();
    }
    if (opened) {
      setPlaylists(opened.getPlaylists());
      setAllCount(opened.getAllSongs().length);
    } else {
      setPlaylists([]);
      setAllCount(0);
    }
  }, []);

  const loadFromDb = useCallback(async (): Promise<VibesDb | null> => {
    if (syncingRef.current) {
      // A sync write is currently in flight (BEGIN..COMMIT in
      // syncLibraryToDb). Opening/reading the db now risks racing that
      // transaction (SQLITE_BUSY) and would show a stale view anyway --
      // runSync reloads on its own right after the write commits, so
      // there's nothing this call needs to do.
      return dbRef.current;
    }
    const opened = await openVibesDb();
    applyDb(opened);
    return opened;
  }, [applyDb]);

  const runSync = useCallback(async () => {
    syncingRef.current = true;
    setSyncing(true);
    setSyncStatus('Syncing your library…');
    try {
      const lib = await fetchLibrary();
      const target = await ensureBaseSchema();
      const result = syncLibraryToDb(target, lib);
      target.close();
      // The write transaction has committed and its connection is closed --
      // clear the in-flight flag before reloading so this reload (and any
      // focus-triggered one racing it) actually runs instead of skipping.
      syncingRef.current = false;
      await loadFromDb();
      setSyncStatus(
        `Synced ${result.playlistCount} playlist${result.playlistCount === 1 ? '' : 's'}, ` +
          `${result.songCount} song${result.songCount === 1 ? '' : 's'}.`,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      const info = (e as {info?: unknown})?.info;
      setSyncStatus(null);
      Alert.alert(
        'Sync failed',
        info != null ? `${message}\n\n${String(info).slice(0, 500)}` : message,
      );
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [loadFromDb]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        setLoading(true);
        const creds = await loadOAuthCreds();
        if (cancelled) return;
        setLoggedIn(creds != null);

        const opened = await loadFromDb();
        if (cancelled) return;

        // Auto-sync: a logged-in user with nothing synced yet (fresh
        // install, or straight after Login navigated here) should never
        // land on an empty screen requiring an extra tap -- this is what
        // makes "nothing appears after connecting" not happen.
        if (
          creds != null &&
          !autoSyncAttemptedRef.current &&
          (opened == null || isEmptyLibrary(opened))
        ) {
          autoSyncAttemptedRef.current = true;
          setLoading(false);
          await runSync();
          return;
        }

        setLoading(false);
      })();
      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  React.useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={styles.headerRow}>
          {loggedIn ? (
            <HeaderButton label="Sync" onPress={runSync} disabled={syncing} />
          ) : null}
          <HeaderButton
            label="Settings"
            onPress={() => navigation.navigate('Settings')}
          />
        </View>
      ),
    });
  }, [navigation, loggedIn, syncing, runSync]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#5b8def" />
      </View>
    );
  }

  if (!db) {
    return (
      <View style={styles.center}>
        {syncing ? (
          <>
            <ActivityIndicator color="#5b8def" style={styles.emptySpinner} />
            <Text style={styles.emptyText}>{syncStatus ?? 'Syncing…'}</Text>
          </>
        ) : loggedIn ? (
          <>
            <Text style={styles.emptyText}>
              {syncStatus ?? 'Log in succeeded, but nothing has synced yet.'}
            </Text>
            <Pressable style={styles.primaryButton} onPress={runSync}>
              <Text style={styles.primaryButtonText}>Sync library</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.emptyText}>No library yet.</Text>
            <Pressable
              style={styles.primaryButton}
              onPress={() => navigation.navigate('Login')}>
              <Text style={styles.primaryButtonText}>
                Log in to YouTube Music
              </Text>
            </Pressable>
            <Pressable
              style={styles.secondaryButton}
              onPress={() => navigation.navigate('Settings')}>
              <Text style={styles.secondaryButtonText}>
                Import analysis data instead
              </Text>
            </Pressable>
          </>
        )}
      </View>
    );
  }

  const rows: Array<{playlistId: string; name: string; trackCount: number}> =
    [
      {playlistId: ALL_SONGS_ID, name: 'All songs', trackCount: allCount},
      ...playlists,
    ];

  return (
    <View style={styles.container}>
      {syncStatus && !syncing ? (
        <View style={styles.statusBanner}>
          <Text style={styles.statusBannerText}>{syncStatus}</Text>
        </View>
      ) : null}
      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={rows}
        keyExtractor={item => item.playlistId}
        refreshControl={
          loggedIn ? (
            <RefreshControl
              refreshing={syncing}
              onRefresh={runSync}
              tintColor="#5b8def"
            />
          ) : undefined
        }
        renderItem={({item}) => (
          <Pressable
            style={({pressed}) => [styles.row, pressed && styles.rowPressed]}
            onPress={() =>
              navigation.navigate('Playlist', {
                playlistId: item.playlistId,
                playlistName: item.name,
              })
            }>
            <Text style={styles.rowTitle}>{item.name}</Text>
            <Text style={styles.rowSubtitle}>{item.trackCount}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0b0b0f'},
  list: {flex: 1, backgroundColor: '#0b0b0f'},
  listContent: {paddingVertical: 8},
  center: {
    flex: 1,
    backgroundColor: '#0b0b0f',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  emptySpinner: {marginBottom: 16},
  emptyText: {
    color: '#9a9aa8',
    fontSize: 16,
    marginBottom: 20,
    textAlign: 'center',
  },
  primaryButton: {
    backgroundColor: '#5b8def',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    marginBottom: 12,
  },
  primaryButtonText: {color: '#0b0b0f', fontSize: 16, fontWeight: '600'},
  secondaryButton: {paddingHorizontal: 24, paddingVertical: 10},
  secondaryButtonText: {color: '#6f6f7d', fontSize: 14},
  statusBanner: {
    backgroundColor: '#15151c',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#26262f',
  },
  statusBannerText: {color: '#6f6f7d', fontSize: 13, textAlign: 'center'},
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#26262f',
  },
  rowPressed: {backgroundColor: '#15151c'},
  rowTitle: {color: '#f2f2f5', fontSize: 17},
  rowSubtitle: {color: '#6f6f7d', fontSize: 15},
  headerRow: {flexDirection: 'row', alignItems: 'center'},
  headerButton: {paddingHorizontal: 8, paddingVertical: 4},
  headerButtonDisabled: {opacity: 0.5},
  headerButtonText: {color: '#5b8def', fontSize: 16},
});
