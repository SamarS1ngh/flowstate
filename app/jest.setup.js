// Test-environment wiring for the two gesture/animation libs PlayerScreen's
// swipe/pull-down redesign depends on. Neither ships real native code under
// Jest, so both need their official mocks in place before any test file
// that imports PlayerScreen (transitively pulling in both libs) runs.
require('react-native-gesture-handler/jestSetup');

jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
