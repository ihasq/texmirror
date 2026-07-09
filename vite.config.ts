import { defineConfig } from 'vite';
import type { Plugin, ResolvedConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
let prepareBusyTeXAssetsPromise: Promise<void> | null = null;

function prepareBusyTeXAssets() {
  prepareBusyTeXAssetsPromise ??= new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(rootDir, 'scripts', 'prepare-busytex-assets.mjs')], {
      cwd: rootDir,
      stdio: 'inherit'
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`BusyTeX asset preparation failed with status ${code}`));
      }
    });
  });

  return prepareBusyTeXAssetsPromise;
}

function busyTeXAssetsPlugin(): Plugin {
  let config: ResolvedConfig;

  return {
    name: 'texmirror-busytex-assets',
    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },
    async buildStart() {
      await prepareBusyTeXAssets();
    },
    async writeBundle() {
      await prepareBusyTeXAssets();

      const source = path.join(config.publicDir, 'core', 'busytex');
      const destination = path.resolve(config.root, config.build.outDir, 'core', 'busytex');
      await rm(destination, { recursive: true, force: true });
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination, { recursive: true });
    },
    async configureServer(server) {
      await prepareBusyTeXAssets();

      server.middlewares.use(async (request, response, next) => {
        const url = request.url?.split('?')[0] ?? '';
        if (!/^\/core\/busytex\/.+\.part-\d+\.gz$/.test(url)) {
          next();
          return;
        }

        const filePath = path.join(server.config.publicDir, decodeURIComponent(url));

        try {
          const fileStat = await stat(filePath);
          response.statusCode = 200;
          response.setHeader('Content-Length', String(fileStat.size));
          response.setHeader('Content-Type', 'application/octet-stream');
          response.setHeader('Cache-Control', 'no-cache');
          createReadStream(filePath).pipe(response);
        } catch {
          next();
        }
      });
    }
  };
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    busyTeXAssetsPlugin()
  ],
  optimizeDeps: {
    exclude: ['texlyre-busytex']
  },
  server: {
    fs: {
      strict: true
    }
  }
});
