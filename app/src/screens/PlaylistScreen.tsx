import React, {useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../App';
import {openVibesDb} from '../db/vibesDb';
import {playFrom} from '../player/controller';
import {SimpleQueue} from '../player/queue';
import type {Song} from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Playlist'>;

export default function PlaylistScreen({route, navigation}: Props) {
  const {playlistId} = route.params;
  const [loading, setLoading] = useState(true);
  const [songs, setSongs] = useState<Song[]>([]);
  const [startingId, setStartingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const db = await openVibesDb();
      if (cancelled || !db) {
        setLoading(false);
        return;
      }
      const list =
        playlistId === 'ALL'
          ? db.getAllSongs()
          : db.getPlaylistSongs(playlistId);
      if (!cancelled) {
        setSongs(list);
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
      await playFrom(new SimpleQueue(songs, index), song);
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
  );
}

const styles = StyleSheet.create({
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
