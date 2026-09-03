import { defineConfig } from 'vite'

export default defineConfig({
    root: 'src',
    publicDir: '../public',
    base: './',
    server: {
        headers: {
            'Cache-Control': 'no-store'
        }
    },
    worker: {
        format: 'es'
    },
    build: {
        outDir: '../dist',
        emptyOutDir: true,
        target: 'esnext'
    }
})
