import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
  server: {
    proxy: {
      '/api/ollama': {
        target: 'http://localhost:11434',
        rewrite: (path) => path.replace(/^\/api\/ollama/, ''),
        changeOrigin: true,
      },
    },
  },
})
