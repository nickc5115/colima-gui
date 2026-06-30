import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [preact()],
  build: {
    outDir: '../renderer-dist',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
