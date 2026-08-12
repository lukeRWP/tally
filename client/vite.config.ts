/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:2727',
    },
  },
  build: {
    outDir: 'dist',
  },
  test: {
    // jsdom only where a test asks for it (@vitest-environment jsdom), so pure
    // logic tests stay fast and cannot accidentally depend on a DOM.
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: true,
  },
});
