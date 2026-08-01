import React, {useCallback, useMemo, useRef, useState} from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
  ActivityIndicator,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {useFocusEffect} from '@react-navigation/native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../App';
import {ensureBaseSchema, openVibesDb, VibesDb} from '../db/vibesDb';
import {loadOAuthCreds} from '../auth/authStore';
import {fetchLibrary} from '../library/syncClient';
import {syncLibraryToDb} from '../library/syncToDb';
import {playFrom} from '../player/controller';
import {SimpleQueue} from '../player/queue';
import type {Playlist, Song} from '../types';
import Chip from '../ui/Chip';
import IconButton from '../ui/IconButton';
import ListRow from '../ui/ListRow';
import {filterSongs, filterPlaylists} from '../library/search';
import {colors, radii, spacing, type} from '../ui/theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Library'>;

const ALL_SONGS_ID = 'ALL' as const;

type Filter = 'playlists' | 'songs';

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
  const [allSongs, setAllSongs] = useState<Song[]>([]);
  const [coverIds, setCoverIds] = useState<Record<string, string>>({});
  const [loggedIn, setLoggedIn] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('playlists');
  const [search, setSearch] = useState('');
  const [startingId, setStartingId] = useState<string | null>(null);
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
      setAllSongs(opened.getAllSongs());
      setCoverIds(opened.getPlaylistCoverVideoIds());
    } else {
      setPlaylists([]);
      setAllSongs([]);
      setCoverIds({});
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

  // Search filters the in-memory library instantly (no DB round-trip). The
  // active tab shows its filtered subset; an empty query is a no-op that
  // returns the original list reference (see library/search.ts).
  const visibleSongs = useMemo(() => filterSongs(allSongs, search), [allSongs, search]);
  const visiblePlaylists = useMemo(() => filterPlaylists(playlists, search), [playlists, search]);

  // Tapping a row in the "Songs" list plays that song immediately, queuing
  // from the CURRENTLY VISIBLE (possibly search-filtered) list so the queue
  // matches what the user sees. Mirrors PlaylistScreen's plain (non-vibe) tap
  // -- reuses the same exported playFrom/SimpleQueue, no new playback logic.
  const onPressSong = useCallback(
    async (index: number) => {
      const song = visibleSongs[index];
      setStartingId(song.videoId);
      try {
        await playFrom(new SimpleQueue(visibleSongs, index), song);
        navigation.navigate('Player');
      } catch (e) {
        Alert.alert('Could not play song', e instanceof Error ? e.message : 'Unknown error');
      } finally {
        setStartingId(null);
      }
    },
    [visibleSongs, navigation],
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  if (!db) {
    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <LibraryHeader
          loggedIn={loggedIn}
          syncing={syncing}
          onSync={runSync}
          onSettings={() => navigation.navigate('Settings')}
        />
        <View style={styles.center}>
          {syncing ? (
            <>
              <ActivityIndicator color={colors.accent} style={styles.emptySpinner} />
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
                <Text style={styles.primaryButtonText}>Log in to YouTube Music</Text>
              </Pressable>
              <Pressable
                style={styles.secondaryButton}
                onPress={() => navigation.navigate('Settings')}>
                <Text style={styles.secondaryButtonText}>Import analysis data instead</Text>
              </Pressable>
            </>
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <LibraryHeader
        loggedIn={loggedIn}
        syncing={syncing}
        onSync={runSync}
        onSettings={() => navigation.navigate('Settings')}
      />
      <View style={styles.chipRow}>
        <Chip label="Playlists" active={filter === 'playlists'} onPress={() => setFilter('playlists')} />
        <Chip label="Songs" active={filter === 'songs'} onPress={() => setFilter('songs')} />
      </View>
      <View style={styles.searchRow}>
        <Text style={styles.searchIcon}>⌕</Text>
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder={filter === 'songs' ? 'Search songs or artists' : 'Search playlists'}
          placeholderTextColor={colors.textTertiary}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
        {search.length > 0 ? (
          <Pressable onPress={() => setSearch('')} hitSlop={12}>
            <Text style={styles.searchClear}>✕</Text>
          </Pressable>
        ) : null}
      </View>
      {syncStatus && !syncing ? (
        <View style={styles.statusBanner}>
          <Text style={styles.statusBannerText}>{syncStatus}</Text>
        </View>
      ) : null}
      {filter === 'playlists' ? (
        <PlaylistList
          navigation={navigation}
          playlists={visiblePlaylists}
          allCount={allSongs.length}
          coverIds={coverIds}
          loggedIn={loggedIn}
          syncing={syncing}
          onRefresh={runSync}
          hideAllRow={search.trim().length > 0}
        />
      ) : (
        <FlatList
          style={styles.list}
          contentContainerStyle={styles.listContent}
          data={visibleSongs}
          keyExtractor={item => item.videoId}
          initialNumToRender={16}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            search.trim().length > 0 ? (
              <Text style={styles.emptySearch}>No songs match “{search.trim()}”</Text>
            ) : null
          }
          renderItem={({item, index}) => (
            <ListRow
              videoId={item.videoId}
              title={item.title}
              titleBadge={!item.hasVibe ? '♪?' : undefined}
              subtitle={item.artist}
              disabled={startingId !== null}
              onPress={() => onPressSong(index)}
              trailing={
                startingId === item.videoId ? (
                  <ActivityIndicator color={colors.accent} size="small" />
                ) : undefined
              }
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

function LibraryHeader({
  loggedIn,
  syncing,
  onSync,
  onSettings,
}: {
  loggedIn: boolean;
  syncing: boolean;
  onSync: () => void;
  onSettings: () => void;
}) {
  return (
    <View style={styles.header}>
      <Text style={styles.headerTitle}>Library</Text>
      <View style={styles.headerActions}>
        {loggedIn ? (
          <IconButton name="sync" onPress={onSync} disabled={syncing} size={20} />
        ) : null}
        <IconButton name="settings" onPress={onSettings} size={20} />
      </View>
    </View>
  );
}

function PlaylistList({
  navigation,
  playlists,
  allCount,
  coverIds,
  loggedIn,
  syncing,
  onRefresh,
  hideAllRow = false,
}: {
  navigation: Props['navigation'];
  playlists: Playlist[];
  allCount: number;
  coverIds: Record<string, string>;
  loggedIn: boolean;
  syncing: boolean;
  onRefresh: () => void;
  // When searching playlists, the pinned "All songs" pseudo-row isn't a
  // playlist match and would be noise -- hide it so only real name matches show.
  hideAllRow?: boolean;
}) {
  // "All songs" is a pinned pseudo-playlist (not a real row in `playlists`)
  // -- always first, like the reference app's pinned "Liked music". If a
  // real playlist happens to be named "Liked Music" (sync brings this over
  // verbatim from the account), pin it second so both pinned rows sit
  // together above the rest, which is otherwise alphabetical (getPlaylists()
  // orders by name).
  const {pinned, rest} = useMemo(() => {
    const likedIdx = playlists.findIndex(p => p.name.toLowerCase() === 'liked music');
    const liked = likedIdx >= 0 ? playlists[likedIdx] : null;
    const others = likedIdx >= 0 ? playlists.filter((_, i) => i !== likedIdx) : playlists;
    return {pinned: liked, rest: others};
  }, [playlists]);

  type Row =
    | {kind: 'all'}
    | {kind: 'liked'; playlist: Playlist}
    | {kind: 'playlist'; playlist: Playlist};

  const rows: Row[] = [
    ...(hideAllRow ? [] : [{kind: 'all' as const}]),
    ...(pinned ? [{kind: 'liked' as const, playlist: pinned}] : []),
    ...rest.map(p => ({kind: 'playlist' as const, playlist: p})),
  ];

  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.listContent}
      data={rows}
      keyExtractor={item => (item.kind === 'all' ? ALL_SONGS_ID : item.playlist.playlistId)}
      refreshControl={
        loggedIn ? (
          <RefreshControl refreshing={syncing} onRefresh={onRefresh} tintColor={colors.accent} />
        ) : undefined
      }
      renderItem={({item}) => {
        if (item.kind === 'all') {
          return (
            <ListRow
              title="All songs"
              subtitle={`${allCount} song${allCount === 1 ? '' : 's'}`}
              onPress={() =>
                navigation.navigate('Playlist', {playlistId: ALL_SONGS_ID, playlistName: 'All songs'})
              }
            />
          );
        }
        const {playlist} = item;
        const isPinned = item.kind === 'liked';
        return (
          <ListRow
            videoId={coverIds[playlist.playlistId]}
            title={playlist.name}
            titleBadge={isPinned ? '📌' : undefined}
            subtitle={`Playlist · ${playlist.trackCount} song${playlist.trackCount === 1 ? '' : 's'}`}
            onPress={() =>
              navigation.navigate('Playlist', {
                playlistId: playlist.playlistId,
                playlistName: playlist.name,
              })
            }
          />
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.bg},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  headerTitle: {...type.display},
  headerActions: {flexDirection: 'row', alignItems: 'center'},
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    height: 40,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
  },
  searchIcon: {color: colors.textTertiary, fontSize: 18, marginRight: spacing.sm},
  searchInput: {flex: 1, color: colors.textPrimary, fontSize: 15, padding: 0},
  searchClear: {color: colors.textTertiary, fontSize: 15, paddingLeft: spacing.sm},
  emptySearch: {
    color: colors.textSecondary,
    fontSize: 15,
    textAlign: 'center',
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.lg,
  },
  list: {flex: 1, backgroundColor: colors.bg},
  listContent: {paddingVertical: spacing.sm, paddingBottom: spacing.xxxl},
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
  },
  emptySpinner: {marginBottom: spacing.lg},
  emptyText: {
    color: colors.textSecondary,
    fontSize: 16,
    marginBottom: spacing.xl,
    textAlign: 'center',
  },
  primaryButton: {
    backgroundColor: colors.white,
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.md,
    borderRadius: 999,
    marginBottom: spacing.md,
  },
  primaryButtonText: {color: colors.black, fontSize: 16, fontWeight: '700'},
  secondaryButton: {paddingHorizontal: spacing.xxl, paddingVertical: spacing.sm + 2},
  secondaryButtonText: {color: colors.textSecondary, fontSize: 14},
  statusBanner: {
    backgroundColor: colors.surface,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  statusBannerText: {color: colors.textSecondary, fontSize: 13, textAlign: 'center'},
});
