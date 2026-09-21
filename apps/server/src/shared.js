/**
 * Re-export of the cross-platform core in packages/shared.
 *
 * Imported by relative path rather than as an npm workspace package: that
 * keeps the server free of symlinked node_modules entries, which do not
 * survive every Windows setup or container build.
 */
export * from '../../../packages/shared/src/domain.js';
export { palette, theme, statusColors } from '../../../packages/shared/src/theme.js';
