import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import fs from 'fs';
const devPort = 4000;
const manualHttpsConfig = fs.existsSync('./certs/server.key') && fs.existsSync('./certs/server.crt')
    ? { key: fs.readFileSync('./certs/server.key'), cert: fs.readFileSync('./certs/server.crt') }
    : undefined;
export default defineConfig({
    plugins: [react(), ...(manualHttpsConfig ? [] : [basicSsl()])],
    server: {
        host: '0.0.0.0',
        port: devPort,
        strictPort: true,
        https: manualHttpsConfig ?? {},
        headers: {
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cross-Origin-Opener-Policy': 'same-origin',
        },
        fs: {
            allow: ['..']
        },
        proxy: {
            // Go server: `go run . -addr :8080` (serves /ws + /mix-cache + /game-res).
            '/ws': { target: 'http://127.0.0.1:8080', ws: true, secure: false },
            '/mix-cache': { target: 'http://127.0.0.1:8080', secure: false },
            '/game-res': { target: 'http://127.0.0.1:8080', secure: false },
        },
    },
    preview: {
        host: '0.0.0.0',
        port: devPort,
        strictPort: true,
    },
    resolve: {
        alias: {
            '@': '/src'
        }
    },
    optimizeDeps: {
        exclude: ['7z-wasm', '@ffmpeg/ffmpeg'],
        include: []
    },
    worker: {
        format: 'es'
    },
    assetsInclude: ['**/*.wasm']
});
