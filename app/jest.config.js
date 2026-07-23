module.exports = {
  preset: '@react-native/jest-preset',
  // youtubei.js and @react-native-async-storage/async-storage both ship
  // ESM-only builds; let babel-jest transform them (and their internal
  // relative imports) instead of leaving raw `import` syntax, which Jest's
  // default node_modules exclusion would otherwise choke on.
  transformIgnorePatterns: [
    'node_modules/(?!(youtubei\\.js|(jest-)?react-native|@react-native(-community)?|@react-native-async-storage)/)',
  ],
};
