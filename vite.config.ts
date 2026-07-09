import { defineConfig } from 'vite';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

export default defineConfig({
  plugins: [
    {
      name: 'texmirror-busytex-gzip-chunks',
      configureServer(server) {
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
    }
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
