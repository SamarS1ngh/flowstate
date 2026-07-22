import React, {useState} from 'react';
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
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import type {RootStackParamList} from '../App';
import {importVibesDb} from '../db/vibesDb';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

export default function SettingsScreen({navigation}: Props) {
  const [importingFile, setImportingFile] = useState(false);
  const [syncing, setSyncing] = useState(false);
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
      Alert.alert('Import complete', 'vibes.db imported successfully.', [
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
      Alert.alert('Sync complete', 'vibes.db synced successfully.', [
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
        <Text style={styles.sectionTitle}>Import vibes.db from file</Text>
        <Text style={styles.sectionBody}>
          Pick a vibes.db file from device storage or a cloud provider.
        </Text>
        <Pressable
          style={[styles.button, importingFile && styles.buttonDisabled]}
          disabled={importingFile}
          onPress={onImportFromFile}>
          {importingFile ? (
            <ActivityIndicator color="#0b0b0f" />
          ) : (
            <Text style={styles.buttonText}>Choose file</Text>
          )}
        </Pressable>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Sync from PC over wifi</Text>
        <Text style={styles.sectionBody}>
          Enter the URL shown by the analyzer's `serve` command running on
          your PC.
        </Text>
        <TextInput
          style={styles.input}
          value={syncUrl}
          onChangeText={setSyncUrl}
          placeholder="http://192.168.0.X:8765/vibes.db"
          placeholderTextColor="#6f6f7d"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Pressable
          style={[styles.button, syncing && styles.buttonDisabled]}
          disabled={syncing}
          onPress={onSyncFromWifi}>
          {syncing ? (
            <ActivityIndicator color="#0b0b0f" />
          ) : (
            <Text style={styles.buttonText}>Sync now</Text>
          )}
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#0b0b0f'},
  content: {padding: 20},
  section: {
    marginBottom: 32,
    backgroundColor: '#15151c',
    borderRadius: 12,
    padding: 16,
  },
  sectionTitle: {
    color: '#f2f2f5',
    fontSize: 17,
    fontWeight: '600',
    marginBottom: 6,
  },
  sectionBody: {color: '#9a9aa8', fontSize: 14, marginBottom: 16},
  input: {
    borderWidth: 1,
    borderColor: '#26262f',
    borderRadius: 8,
    color: '#f2f2f5',
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 14,
    backgroundColor: '#0b0b0f',
  },
  button: {
    backgroundColor: '#5b8def',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonDisabled: {opacity: 0.6},
  buttonText: {color: '#0b0b0f', fontSize: 16, fontWeight: '600'},
});
