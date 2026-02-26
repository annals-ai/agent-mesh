import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  shims: true,
  clean: true,
  dts: true,
  noExternal: ['@annals/bridge-protocol'],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
