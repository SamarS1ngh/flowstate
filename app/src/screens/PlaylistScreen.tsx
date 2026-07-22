import React, {useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../App';
import {openVibesDb, VibesDb} from '../db/vibesDb';
import {playFrom, reportFallback} from '../player/controller';
import {SimpleQueue} from '../player/queue';
import {VibeQueue} from '../engine/vibeQueue';
import {VibeSong} from '../engine/similarity';
import {FeedbackStore} from '../engine/feedbackStore';
import type {Song} from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Playlist'>;

// Below this many analyzed songs, VibeQueue's similarity pool is too thin to
// be a good default experience -- vibe mode starts OFF (user can still turn
// it on) but flips ON automatically once the playlist has enough coverage.
const VIBE_MODE_MIN_ANALYZED = 10;

// TODO(device verification): no device/emulator was available while building
// this screen. tsc + jest are clean, but the "Vibe mode" toggle, the
// analyzed-count badge, and building a VibeQueue from a real vibes.db have
// not been exercised on-device. Verify before relying on this for the
// release build (see Task 4).
export default function PlaylistScreen({route, navigation}: Props) {
  const {playlistId} = route.params;
  const [loading, setLoading] = useState(true);
  const [songs, setSongs] = useState<Song[]>([]);
  const [vibeSongs, setVibeSongs] = useState<VibeSong[]>([]);
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
        playlistId === 'ALL'
          ? opened.getAllSongs()
          : opened.getPlaylistSongs(playlistId);
      const analyzed = opened.getVibeSongs(playlistId);
      if (!cancelled) {
        setDb(opened);
        setSongs(list);
        setVibeSongs(analyzed);
        setVibeMode(analyzed.length >= VIBE_MODE_MIN_ANALYZED);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [playlistId]);

  const onPressSong = async (index: number) => {
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
      Alert.alert(
        'Could not play song',
        e instanceof Error ? e.message : 'Unknown error',
      );
    } finally {
      setStartingId(null);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#5b8def" />
      </View>
    );
  }

  if (songs.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>No songs in this playlist.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.vibeHeader}>
        <View style={styles.vibeHeaderLeft}>
          <Text style={styles.vibeHeaderTitle}>Vibe mode</Text>
          <Text style={styles.vibeHeaderBadge}>
            {vibeSongs.length}/{songs.length} analyzed
          </Text>
        </View>
        <Switch
          value={vibeMode}
          onValueChange={setVibeMode}
          trackColor={{false: '#26262f', true: '#5b8def'}}
          thumbColor="#f2f2f5"
        />
      </View>
      {notice ? (
        <View style={styles.noticeBanner}>
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      ) : null}
      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={songs}
        keyExtractor={item => item.videoId}
        renderItem={({item, index}) => (
          <Pressable
            style={({pressed}) => [styles.row, pressed && styles.rowPressed]}
            disabled={startingId !== null}
            onPress={() => onPressSong(index)}>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.title}
                {!item.hasVibe ? ' ♪?' : ''}
              </Text>
              <Text style={styles.rowSubtitle} numberOfLines={1}>
                {item.artist}
              </Text>
            </View>
            {startingId === item.videoId ? (
              <ActivityIndicator color="#5b8def" />
            ) : null}
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0b0b0f'},
  vibeHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#26262f',
    backgroundColor: '#15151c',
  },
  vibeHeaderLeft: {flexDirection: 'row', alignItems: 'center'},
  vibeHeaderTitle: {
    color: '#f2f2f5',
    fontSize: 15,
    fontWeight: '600',
    marginRight: 10,
  },
  vibeHeaderBadge: {color: '#6f6f7d', fontSize: 13},
  noticeBanner: {
    backgroundColor: '#15151c',
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#26262f',
  },
  noticeText: {color: '#9a9aa8', fontSize: 12, textAlign: 'center'},
  list: {flex: 1, backgroundColor: '#0b0b0f'},
  listContent: {paddingVertical: 8},
  center: {
    flex: 1,
    backgroundColor: '#0b0b0f',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  emptyText: {color: '#9a9aa8', fontSize: 16},
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#26262f',
  },
  rowPressed: {backgroundColor: '#15151c'},
  rowText: {flex: 1, marginRight: 12},
  rowTitle: {color: '#f2f2f5', fontSize: 16},
  rowSubtitle: {color: '#6f6f7d', fontSize: 14, marginTop: 2},
});
