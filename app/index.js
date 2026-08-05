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

AppRegistry.registerComponent(appName, () => App);
TrackPlayer.registerPlaybackService(() => playbackService);
// Background analysis loop: AnalysisForegroundService (a HeadlessJsTaskService)
// kicks this task; RN keeps its JS alive in the background so the loop keeps
// running when the app is backgrounded / the screen is off.
AppRegistry.registerHeadlessTask('flowstateAnalysis', () => runHeadlessAnalysis);
