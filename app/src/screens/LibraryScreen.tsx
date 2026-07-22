import React, {useCallback, useState} from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  ActivityIndicator,
} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../App';
import {openVibesDb, VibesDb} from '../db/vibesDb';
import type {Playlist} from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Library'>;

const ALL_SONGS_ID = 'ALL' as const;

function SettingsHeaderButton({onPress}: {onPress: () => void}) {
  return (
    <Pressable onPress={onPress} hitSlop={12} style={styles.headerButton}>
      <Text style={styles.headerButtonText}>Settings</Text>
    </Pressable>
  );
}

export default function LibraryScreen({navigation}: Props) {
  const [loading, setLoading] = useState(true);
  const [db, setDb] = useState<VibesDb | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [allCount, setAllCount] = useState(0);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        setLoading(true);
        const opened = await openVibesDb();
        if (cancelled) return;
        setDb(opened);
        if (opened) {
          setPlaylists(opened.getPlaylists());
          setAllCount(opened.getAllSongs().length);
        }
        setLoading(false);
      })();
      return () => {
        cancelled = true;
      };
    }, []),
  );

  React.useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <SettingsHeaderButton
          onPress={() => navigation.navigate('Settings')}
        />
      ),
    });
  }, [navigation]);

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
        <Text style={styles.emptyText}>No library imported yet.</Text>
        <Pressable
          style={styles.primaryButton}
          onPress={() => navigation.navigate('Settings')}>
          <Text style={styles.primaryButtonText}>Import vibes.db</Text>
        </Pressable>
      </View>
    );
  }

  const rows: Array<{playlistId: string; name: string; trackCount: number}> =
    [
      {playlistId: ALL_SONGS_ID, name: 'All songs', trackCount: allCount},
      ...playlists,
    ];

  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.listContent}
      data={rows}
      keyExtractor={item => item.playlistId}
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
  emptyText: {color: '#9a9aa8', fontSize: 16, marginBottom: 20},
  primaryButton: {
    backgroundColor: '#5b8def',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  primaryButtonText: {color: '#0b0b0f', fontSize: 16, fontWeight: '600'},
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
  headerButton: {paddingHorizontal: 8, paddingVertical: 4},
  headerButtonText: {color: '#5b8def', fontSize: 16},
});
