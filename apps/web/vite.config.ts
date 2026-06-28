import { defineConfig } from 'vite';
import tsconfigPaths from 'vite-tsconfig-paths';
import { reactRouter } from '@react-router/dev/vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(fileURLToPath(new URL('.', import.meta.url)), 'app');

export default defineConfig({
  plugins: [reactRouter(), tsconfigPaths()],
  resolve: {
    alias: [
      { find: /^~\/(.*)$/, replacement: `${appDir}/$1` },
    ],
  },
  server: {
    port: 3011,
  },
});