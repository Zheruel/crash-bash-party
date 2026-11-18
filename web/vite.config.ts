import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(here, '../assets');
const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream', '.json': 'application/json',
};

/** Serves ../assets read-only at /assets (404 when missing, so the client can fall back to placeholders). */
function assetsPlugin(): Plugin {
  return {
    name: 'serve-game-assets',
    configureServer(server) {
      server.middlewares.use('/assets', (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
        if (rel === '/models/index.json') {
          // listing for the asset viewer (viewer.html)
          const ids = fs.existsSync(path.join(ASSETS, 'models'))
            ? fs.readdirSync(path.join(ASSETS, 'models')).filter((f) => /^\d{4}\.gltf$/.test(f)).map((f) => Number(f.slice(0, 4))).sort((a, b) => a - b)
            : [];
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(ids));
          return;
        }
        const file = path.resolve(ASSETS, '.' + path.posix.normalize('/' + rel));
        if (!file.startsWith(ASSETS + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

/** Copies ../assets into dist/assets so the static build (GitHub Pages) can fetch models, textures and catalog.json. */
function copyAssetsPlugin(): Plugin {
  let out = 'dist';
  return {
    name: 'copy-game-assets',
    apply: 'build',
    configResolved(c) { out = path.resolve(c.root, c.build.outDir); },
    closeBundle() {
      if (!fs.existsSync(ASSETS) || process.env.NO_ASSETS === '1') return;
      execFileSync(process.execPath, [path.resolve(here, 'scripts/copy-assets.mjs'), ASSETS, path.join(out, 'assets')], { stdio: 'inherit' });
    },
  };
}

export default defineConfig({
  // relative base: works under https://USER.github.io/REPO/ as well as at the root
  base: './',
  plugins: [assetsPlugin(), copyAssetsPlugin()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: { '/ws': { target: 'ws://127.0.0.1:8787', ws: true } },
  },
  // assetsDir must not be "assets": that path is reserved for game art
  build: {
    chunkSizeWarningLimit: 1200,
    assetsDir: 'static',
    rollupOptions: { input: { main: path.resolve(here, 'index.html'), viewer: path.resolve(here, 'viewer.html') } },
  },
});
