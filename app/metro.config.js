const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  resolver: {
    // react-native-fast-tflite loads bundled models via require('./model.tflite');
    // Metro only treats an extension as a binary asset (returning a resolved
    // file path/module id instead of trying to parse it as JS) once it's
    // listed here.
    assetExts: [...getDefaultConfig(__dirname).resolver.assetExts, 'tflite'],
    resolveRequest: (context, moduleName, platform) => {
      // youtubei.js's "react-native" export condition points at its raw
      // dist/src/platform/react-native.js, which pulls in the package's full
      // multi-file ESM module graph. That graph has a genuine circular
      // dependency (Video.js -> ExpandableMetadata.js -> HorizontalCardList.js
      // -> VideoCard.js -> Video.js): under Metro's per-file CommonJS
      // transform, whichever file in the cycle is required last sees an
      // still-uninitialized `Video` binding, so `class VideoCard extends
      // Video` throws "Super expression must either be null or a function"
      // (confirmed via on-device symbolicated stack trace, Round-4 addendum).
      // The package also ships `bundle/react-native.js`, a single-file esbuild
      // bundle for the same platform target where esbuild already resolved
      // the cycle into a safe definition order (`Video` is assigned before
      // `VideoCard`'s class body runs). Redirect only this package to that
      // prebuilt bundle; everything else uses Metro's default resolution.
      if (moduleName === 'youtubei.js') {
        return {
          filePath: path.resolve(__dirname, 'node_modules/youtubei.js/bundle/react-native.js'),
          type: 'sourceFile',
        };
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
