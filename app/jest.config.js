module.exports = {
  preset: '@react-native/jest-preset',
  // youtubei.js ships ESM-only source; let babel-jest transform it (and its
  // internal relative imports) instead of leaving it as raw `import` syntax,
  // which Jest's default node_modules exclusion would otherwise choke on.
  transformIgnorePatterns: [
    'node_modules/(?!(youtubei\\.js|(jest-)?react-native|@react-native(-community)?)/)',
  ],
};
