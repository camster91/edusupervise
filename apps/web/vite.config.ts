import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import { reactRouter } from '@react-router/dev/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), 'app');

export default defineConfig({
  plugins: [reactRouter(), tsconfigPaths()],
  resolve: {
    // Map ~/x to ./app/x (without extension). Vite's default extension
    // resolution handles the .ts / .tsx lookup.
    alias: {
      '~': appDir,
    },
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
  },
  server: {
    port: 3011,
  },
});