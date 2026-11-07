import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

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
        target: 'esnext',
        rollupOptions: {
            input: {
                home: resolve(__dirname, 'src/index.html'),
                membraneDynamics: resolve(__dirname, 'src/membrane-dynamics.html')
            }
        }
    }
})
