import React, {useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {SafeAreaView, useSafeAreaInsets} from 'react-native-safe-area-context';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../App';
import {openVibesDb, VibesDb} from '../db/vibesDb';
import {playFrom, reportFallback} from '../player/controller';
import {SimpleQueue} from '../player/queue';
import {VibeQueue} from '../engine/vibeQueue';
import {VibeSong} from '../engine/similarity';
import {FeedbackStore} from '../engine/feedbackStore';
import type {Song} from '../types';
import Chip from '../ui/Chip';
import CircleButton from '../ui/CircleButton';
import Collage from '../ui/Collage';
import IconButton from '../ui/IconButton';
import ListRow from '../ui/ListRow';
import {colors, spacing, type} from '../ui/theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Playlist'>;

// Below this many analyzed songs, VibeQueue's similarity pool is too thin to
// be a good default experience -- vibe mode starts OFF (user can still turn
// it on) but flips ON automatically once the playlist has enough coverage.
const VIBE_MODE_MIN_ANALYZED = 10;

export default function PlaylistScreen({route, navigation}: Props) {
  const {playlistId, playlistName} = route.params;
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [songs, setSongs] = useState<Song[]>([]);
  const [vibeSongs, setVibeSongs] = useState<VibeSong[]>([]);
  const [coverIds, setCoverIds] = useState<string[]>([]);
  const [db, setDb] = useState<VibesDb | null>(null);
  const [vibeMode, setVibeMode] = useState(false);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Brief, auto-dismissing in-screen notice (no toast dependency in this
  // app) -- currently only used for the "vibe ON but this song isn't
  // analyzed yet" fallback below.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2500);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const opened = await openVibesDb();
      if (cancelled || !opened) {
        setLoading(false);
        return;
      }
      const list =
        playlistId === 'ALL' ? opened.getAllSongs() : opened.getPlaylistSongs(playlistId);
      const analyzed = opened.getVibeSongs(playlistId);
      const covers = opened.getFirstVideoIds(playlistId, 4);
      if (!cancelled) {
        setDb(opened);
        setSongs(list);
        setVibeSongs(analyzed);
        setCoverIds(covers);
        setVibeMode(analyzed.length >= VIBE_MODE_MIN_ANALYZED);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [playlistId]);

  const playIndex = async (index: number) => {
    const song = songs[index];
    setStartingId(song.videoId);
    try {
      const seed = vibeSongs.find(v => v.videoId === song.videoId);
      // Vibe mode only applies when the tapped song is analyzed -- an
      // unanalyzed seed has no embedding, and VibeQueue.reset() would throw
      // (see engine/vibeQueue.ts: reset requires the seed to be in scope).
      // Falling back to SimpleQueue here is what guards against that throw.
      if (vibeMode && seed && db) {
        // ensureTables() is a defensive no-op CREATE TABLE IF NOT EXISTS --
        // App.tsx already calls it once at bootstrap, but this covers the
        // case where vibes.db was imported after that bootstrap ran.
        const feedbackStore = new FeedbackStore(db.handle);
        feedbackStore.ensureTables();
        const feedback = feedbackStore.snapshot(Date.now());
        const queue = new VibeQueue(seed, 'drift', {
          songs: vibeSongs,
          feedback,
          onFallback: reportFallback,
        });
        await playFrom(queue, seed.song);
      } else {
        if (vibeMode && !seed) {
          // Vibe mode is ON, but this particular song has no analysis data
          // -- the SimpleQueue fallback below is silent otherwise, which
          // reads as vibe mode randomly "not working" for some songs.
          setNotice('Song not analyzed yet — normal queue');
        }
        await playFrom(new SimpleQueue(songs, index), song);
      }
      navigation.navigate('Player');
    } catch (e) {
      Alert.alert('Could not play song', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setStartingId(null);
    }
  };

  // "Vibe shuffle": starts a vibe session from a random analyzed song
  // instead of one the user picked -- same VibeQueue construction as tapping
  // an analyzed row above, just with a randomly-chosen seed. No new engine
  // behavior, purely a different seed choice.
  const onVibeShuffle = async () => {
    if (!db || vibeSongs.length === 0) return;
    const seed = vibeSongs[Math.floor(Math.random() * vibeSongs.length)];
    setStartingId(seed.videoId);
    try {
      const feedbackStore = new FeedbackStore(db.handle);
      feedbackStore.ensureTables();
      const feedback = feedbackStore.snapshot(Date.now());
      const queue = new VibeQueue(seed, 'drift', {
        songs: vibeSongs,
        feedback,
        onFallback: reportFallback,
      });
      await playFrom(queue, seed.song);
      navigation.navigate('Player');
    } catch (e) {
      Alert.alert('Could not start vibe shuffle', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setStartingId(null);
    }
  };

  const analyzedCount = vibeSongs.length;
  const subtitle = useMemo(
    () => `${songs.length} song${songs.length === 1 ? '' : 's'} · ${analyzedCount} analyzed`,
    [songs.length, analyzedCount],
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Absolutely-positioned children ignore their parent's padding (CSS
          padding-box semantics), so the SafeAreaView's top inset above
          doesn't shift this floating back button on its own -- insets.top
          is added explicitly here instead. */}
      <View style={[styles.backRow, {top: insets.top + spacing.sm}]}>
        <IconButton name="chevronBack" size={28} onPress={() => navigation.goBack()} filled />
      </View>
      {songs.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyText}>No songs in this playlist.</Text>
        </View>
      ) : (
        <FlatList
          style={styles.list}
          contentContainerStyle={styles.listContent}
          data={songs}
          keyExtractor={item => item.videoId}
          initialNumToRender={14}
          ListHeaderComponent={
            <View style={styles.header}>
              <Collage videoIds={coverIds} size={200} />
              <Text style={styles.title} numberOfLines={2}>
                {playlistName}
              </Text>
              <Text style={styles.subtitle}>{subtitle}</Text>

              <View style={styles.actionsRow}>
                <CircleButton
                  icon="play"
                  size={64}
                  onPress={() => songs.length > 0 && playIndex(0)}
                />
                <Pressable
                  style={[styles.vibeShuffleButton, vibeSongs.length === 0 && styles.disabled]}
                  disabled={vibeSongs.length === 0}
                  onPress={onVibeShuffle}>
                  <Text style={styles.vibeShuffleText}>✨ Vibe shuffle</Text>
                </Pressable>
              </View>

              <View style={styles.vibeToggleRow}>
                <Chip label="Vibe mode: On" active={vibeMode} onPress={() => setVibeMode(true)} tone="accent" />
                <Chip label="Vibe mode: Off" active={!vibeMode} onPress={() => setVibeMode(false)} />
              </View>

              {notice ? (
                <View style={styles.noticeBanner}>
                  <Text style={styles.noticeText}>{notice}</Text>
                </View>
              ) : null}
            </View>
          }
          renderItem={({item, index}) => (
            <ListRow
              videoId={item.videoId}
              title={item.title}
              titleBadge={!item.hasVibe ? '♪?' : undefined}
              subtitle={item.durationS != null ? `${item.artist} · ${formatDuration(item.durationS)}` : item.artist}
              disabled={startingId !== null}
              onPress={() => playIndex(index)}
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

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.bg},
  backRow: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.md,
    zIndex: 10,
  },
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl},
  emptyText: {color: colors.textSecondary, fontSize: 16},
  list: {flex: 1, backgroundColor: colors.bg},
  listContent: {paddingBottom: spacing.xxxl},
  header: {alignItems: 'center', paddingTop: spacing.xxxl, paddingHorizontal: spacing.lg},
  title: {...type.title, marginTop: spacing.lg, textAlign: 'center'},
  subtitle: {color: colors.textSecondary, fontSize: 14, marginTop: spacing.xs},
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.xl,
  },
  vibeShuffleButton: {
    marginLeft: spacing.lg,
    backgroundColor: colors.chipBg,
    borderRadius: 999,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  disabled: {opacity: 0.4},
  vibeShuffleText: {color: colors.textPrimary, fontSize: 14, fontWeight: '700'},
  vibeToggleRow: {
    flexDirection: 'row',
    marginTop: spacing.xl,
  },
  noticeBanner: {marginTop: spacing.md},
  noticeText: {color: colors.textTertiary, fontSize: 12, textAlign: 'center'},
});
