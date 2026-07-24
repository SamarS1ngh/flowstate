module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // youtubei.js's shipped ESM (`export * as X from './y.js'`) needs this
  // transform when Jest converts modules to CommonJS; @react-native/babel-preset
  // doesn't include it since Hermes/Metro accept the syntax without lowering it.
  plugins: [
    '@babel/plugin-transform-export-namespace-from',
    // Reanimated 4 delegates its worklet transform to react-native-worklets
    // (react-native-reanimated/plugin is now just a compat re-export of this
    // same plugin) -- it rewrites worklets (e.g. gesture callbacks passed to
    // react-native-gesture-handler) and MUST be listed last, since it needs
    // to see the output of every other plugin/preset first.
    'react-native-worklets/plugin',
  ],
};
