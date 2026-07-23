// metro.config.js
//
// Monorepo Metro config. Resolves workspace packages
// (@edusupervise/db, @edusupervise/schemas) from the repo root
// sibling of node_modules so Metro can find them.
//
// Why: in a pnpm workspace, `pnpm` symlinks each `workspace:*` dep
// into the app's node_modules. Metro's default watchman config will
// follow the symlink once, but if the package's source files are in
// a sibling directory, we need to add the repo root to `watchFolders`
// so Metro's file-watcher sees the source.

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Watch all packages in the monorepo.
config.watchFolders = [workspaceRoot];

// Let Metro resolve modules from the workspace root as well.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Force Metro to resolve (sub)dependencies from the closest node_modules.
// This prevents the "double React" problem when a workspace package
// transitively depends on a different version of a library than the
// app itself uses.
config.resolver.disableHierarchicalLookup = false;

module.exports = config;
