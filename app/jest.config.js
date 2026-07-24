module.exports = {
  preset: '@react-native/jest-preset',
  // react-native-gesture-handler/jestSetup.js + react-native-reanimated's
  // official mock (see jest.setup.js) so PlayerScreen's swipe/pull-down
  // gestures don't need real native animation frames under Jest.
  setupFiles: ['<rootDir>/jest.setup.js'],
  // youtubei.js and @react-native-async-storage/async-storage both ship
  // ESM-only builds; let babel-jest transform them (and their internal
  // relative imports) instead of leaving raw `import` syntax, which Jest's
  // default node_modules exclusion would otherwise choke on.
  transformIgnorePatterns: [
    'node_modules/(?!(youtubei\\.js|(jest-)?react-native|@react-native(-community)?|@react-native-async-storage)/)',
  ],
};
