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
    'node_modules/(?!(youtubei\\.js|(jest-)?react-native|@react-native(-community)?|@react-native-async-storage|@dr\\.pogodin/react-native-fs)/)',
  ],
  // react-native-fast-tflite's models are loaded via require('./model.tflite')
  // (a Metro asset, see metro.config.js's assetExts addition). Jest doesn't
  // go through Metro, so without this, requiring a .tflite file would try to
  // parse its binary contents as JS. Reuse RN's asset transformer (the same
  // one the preset wires up for png/jpg/etc) so the require resolves to a
  // harmless mock object instead -- tflite.ts's tests never load native
  // tflite in Jest regardless (see __tests__/tflite.test.ts).
  transform: {
    '^.+\\.tflite$': require.resolve(
      '@react-native/jest-preset/jest/assetFileTransformer.js',
    ),
  },
};
