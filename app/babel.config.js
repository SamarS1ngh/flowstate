module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // youtubei.js's shipped ESM (`export * as X from './y.js'`) needs this
  // transform when Jest converts modules to CommonJS; @react-native/babel-preset
  // doesn't include it since Hermes/Metro accept the syntax without lowering it.
  plugins: ['@babel/plugin-transform-export-namespace-from'],
};
