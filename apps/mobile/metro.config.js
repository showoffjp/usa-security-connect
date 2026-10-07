// Expo's defaults: it detects the npm workspace, watches the monorepo root
// (the app imports the shared domain rules from packages/shared) and resolves
// dependencies from the root node_modules, where they are hoisted.
const { getDefaultConfig } = require('expo/metro-config');

module.exports = getDefaultConfig(__dirname);
