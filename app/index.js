/**
 * @format
 */

import './src/polyfills';
import { AppRegistry } from 'react-native';
import TrackPlayer from 'react-native-track-player';
import App from './src/App';
import { name as appName } from './app.json';
import { playbackService } from './src/player/service';
import { runHeadlessAnalysis } from './src/analyze/analyzer';
import { runNightlyBackup } from './src/backup/drive';

AppRegistry.registerComponent(appName, () => App);
TrackPlayer.registerPlaybackService(() => playbackService);
// Background analysis loop: AnalysisForegroundService (a HeadlessJsTaskService)
// kicks this task; RN keeps its JS alive in the background so the loop keeps
// running when the app is backgrounded / the screen is off.
AppRegistry.registerHeadlessTask('flowstateAnalysis', () => runHeadlessAnalysis);
// Nightly Drive backup: BackupTaskService (a HeadlessJsTaskService) is fired by
// an AlarmManager alarm at ~2 AM (BackupSchedulerModule) and runs this task.
AppRegistry.registerHeadlessTask('flowstateBackup', () => runNightlyBackup);
