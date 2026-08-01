// Test-environment wiring for the two gesture/animation libs PlayerScreen's
// swipe/pull-down redesign depends on. Neither ships real native code under
// Jest, so both need their official mocks in place before any test file
// that imports PlayerScreen (transitively pulling in both libs) runs.
require('react-native-gesture-handler/jestSetup');

jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));

// react-native-background-actions pulls in native modules that don't exist
// under Jest; analyzer.ts loads it defensively (try/require) but the require
// itself can throw at import time, so stub it to a no-op foreground service.
// NetInfo touches native modules absent under Jest; analyzer.ts uses it for
// the Wi-Fi-only guard. Stub to a connected-Wi-Fi no-op.
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: jest.fn(() => () => {}),
    fetch: jest.fn(async () => ({type: 'wifi', isConnected: true})),
  },
}));

jest.mock('react-native-background-actions', () => ({
  default: {
    start: jest.fn(async (task) => {
      await task();
    }),
    stop: jest.fn(async () => {}),
    updateNotification: jest.fn(async () => {}),
    isRunning: jest.fn(() => false),
  },
}));
