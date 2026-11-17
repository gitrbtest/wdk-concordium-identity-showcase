// Metro (the development server that bundles the app's JavaScript): Expo's defaults, plus one substitution for
// WDK's EVM module, whose sodium-universal dependency is native in Node/Bare (see src/shims/sodium-universal.js).
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);
const shims = { 'sodium-universal': path.resolve(__dirname, 'src/shims/sodium-universal.js') };
const resolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) =>
  shims[moduleName] ? { type: 'sourceFile', filePath: shims[moduleName] }
    : (resolve ?? context.resolveRequest)(context, moduleName, platform);
module.exports = config;
