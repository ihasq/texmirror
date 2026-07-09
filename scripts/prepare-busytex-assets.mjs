#!/usr/bin/env node

import { createGzip } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_ROOT = path.join(ROOT, '.cache', 'busytex', 'raw-root');
const RAW_BUSYTEXT_DIR = path.join(RAW_ROOT, 'busytex');
const LEGACY_PUBLIC_BUSYTEXT_DIR = path.join(ROOT, 'public', 'core', 'busytex');
const PUBLIC_BUSYTEXT_DIR = LEGACY_PUBLIC_BUSYTEXT_DIR;
const CHUNK_SIZE = 20 * 1024 * 1024;
const DEPLOY_ASSET_VERSION = 2;

const requiredRawFiles = [
  'busytex.js',
  'busytex.wasm',
  'busytex_pipeline.js',
  'busytex_worker.js',
  'texlive-extra.data',
  'texlive-extra.js'
];

async function main() {
  await ensureRawAssets();
  await patchRawAssets();
  await writeDeployAssets();
}

async function ensureRawAssets() {
  if (await hasRequiredFiles(RAW_BUSYTEXT_DIR)) return;

  if (await hasRequiredFiles(LEGACY_PUBLIC_BUSYTEXT_DIR)) {
    console.log('Seeding BusyTeX raw cache from existing public assets...');
    await fs.rm(RAW_BUSYTEXT_DIR, { recursive: true, force: true });
    await copyPath(LEGACY_PUBLIC_BUSYTEXT_DIR, RAW_BUSYTEXT_DIR);
    return;
  }

  console.log('BusyTeX raw assets are missing; downloading runtime assets...');
  await fs.rm(RAW_ROOT, { recursive: true, force: true });
  await fs.mkdir(RAW_ROOT, { recursive: true });
  await run(process.execPath, [
    path.join(ROOT, 'node_modules', 'texlyre-busytex', 'scripts', 'cli.cjs'),
    'download-assets',
    RAW_ROOT
  ]);
}

async function hasRequiredFiles(directory) {
  for (const file of requiredRawFiles) {
    try {
      await fs.access(path.join(directory, file));
    } catch {
      return false;
    }
  }
  return true;
}

async function patchRawAssets() {
  await run(process.execPath, [
    path.join(ROOT, 'scripts', 'patch-busytex-assets.mjs'),
    RAW_BUSYTEXT_DIR
  ]);
}

async function writeDeployAssets() {
  const manifestPath = path.join(PUBLIC_BUSYTEXT_DIR, 'busytex-assets.json');
  const nextManifest = await buildManifestDraft();
  const currentManifest = await readJsonIfExists(manifestPath);

  if (isCurrentManifest(currentManifest, nextManifest)) {
    console.log('Chunked BusyTeX deploy assets are current.');
    return;
  }

  const tempDir = path.join(ROOT, '.cache', 'busytex', 'public-next');
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(tempDir, { recursive: true });

  await copyPath(path.join(RAW_BUSYTEXT_DIR, 'busytex.js'), path.join(tempDir, 'busytex.js'));
  await copyPath(path.join(RAW_BUSYTEXT_DIR, 'busytex_pipeline.js'), path.join(tempDir, 'busytex_pipeline.js'));
  await copyPath(path.join(RAW_BUSYTEXT_DIR, 'texlive-extra.js'), path.join(tempDir, 'texlive-extra.js'));
  await copyPath(path.join(ROOT, 'node_modules', 'idb-keyval', 'dist', 'umd.js'), path.join(tempDir, 'idb-keyval.js'));
  await fs.writeFile(path.join(tempDir, 'busytex_chunked_assets.js'), CHUNKED_ASSETS_HELPER);
  await fs.writeFile(path.join(tempDir, 'busytex_worker.js'), WORKER_SHIM);

  const manifest = {
    version: DEPLOY_ASSET_VERSION,
    chunkSize: CHUNK_SIZE,
    assets: {}
  };

  manifest.assets['busytex.wasm'] = await gzipAndChunkAsset({
    source: path.join(RAW_BUSYTEXT_DIR, 'busytex.wasm'),
    publicName: 'busytex.wasm',
    contentType: 'application/wasm',
    destination: tempDir
  });
  manifest.assets['texlive-extra.data'] = await gzipAndChunkAsset({
    source: path.join(RAW_BUSYTEXT_DIR, 'texlive-extra.data'),
    publicName: 'texlive-extra.data',
    contentType: 'application/octet-stream',
    destination: tempDir
  });

  await fs.writeFile(
    path.join(tempDir, 'busytex-assets.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  await fs.rm(PUBLIC_BUSYTEXT_DIR, { recursive: true, force: true });
  await fs.mkdir(path.dirname(PUBLIC_BUSYTEXT_DIR), { recursive: true });
  await fs.rename(tempDir, PUBLIC_BUSYTEXT_DIR);
  console.log('Prepared chunked BusyTeX deploy assets.');
}

async function buildManifestDraft() {
  const assets = {};
  for (const [publicName, sourceName, contentType] of [
    ['busytex.wasm', 'busytex.wasm', 'application/wasm'],
    ['texlive-extra.data', 'texlive-extra.data', 'application/octet-stream']
  ]) {
    const stat = await fs.stat(path.join(RAW_BUSYTEXT_DIR, sourceName));
    assets[publicName] = {
      contentType,
      sourceSize: stat.size,
      sourceMtimeMs: Math.trunc(stat.mtimeMs)
    };
  }
  return { version: DEPLOY_ASSET_VERSION, chunkSize: CHUNK_SIZE, assets };
}

function isCurrentManifest(current, draft) {
  if (!current || current.version !== draft.version || current.chunkSize !== draft.chunkSize) {
    return false;
  }

  for (const [name, expected] of Object.entries(draft.assets)) {
    const actual = current.assets?.[name];
    if (
      !actual ||
      actual.contentType !== expected.contentType ||
      actual.sourceSize !== expected.sourceSize ||
      actual.sourceMtimeMs !== expected.sourceMtimeMs ||
      !Array.isArray(actual.chunks) ||
      actual.chunks.length === 0
    ) {
      return false;
    }
  }

  return true;
}

async function gzipAndChunkAsset({ source, publicName, contentType, destination }) {
  const sourceStat = await fs.stat(source);
  const gzipPath = path.join(destination, `${publicName}.gz.tmp`);
  await pipeline(
    createReadStream(source),
    createGzip({ level: 9 }),
    createWriteStream(gzipPath)
  );

  const gzipStat = await fs.stat(gzipPath);
  const chunks = [];
  const input = await fs.open(gzipPath, 'r');
  let chunkOffset = 0;

  try {
    for (let chunkIndex = 0; chunkOffset < gzipStat.size; chunkIndex += 1) {
      const compressedSize = Math.min(CHUNK_SIZE, gzipStat.size - chunkOffset);
      const buffer = Buffer.allocUnsafe(compressedSize);
      const { bytesRead } = await input.read(buffer, 0, compressedSize, chunkOffset);

      if (bytesRead !== compressedSize) {
        throw new Error(`Short read while chunking ${publicName}.`);
      }

      const fileName = `${publicName}.part-${String(chunkIndex).padStart(4, '0')}.gz`;
      await fs.writeFile(path.join(destination, fileName), buffer);
      chunks.push({ path: fileName, compressedSize });
      chunkOffset += compressedSize;
    }
  } finally {
    await input.close();
  }

  await fs.rm(gzipPath, { force: true });

  const oversized = chunks.find((chunk) => chunk.compressedSize > CHUNK_SIZE);
  if (oversized) {
    throw new Error(`Chunk too large for ${publicName}: ${oversized.path}`);
  }
  if (chunkOffset !== gzipStat.size) {
    throw new Error(`Chunked size mismatch for ${publicName}.`);
  }

  console.log(
    `${publicName}: ${formatBytes(sourceStat.size)} -> ${formatBytes(gzipStat.size)} in ${chunks.length} gzip chunks`
  );

  return {
    contentType,
    encoding: 'gzip',
    sourceSize: sourceStat.size,
    sourceMtimeMs: Math.trunc(sourceStat.mtimeMs),
    compressedSize: gzipStat.size,
    chunks
  };
}

async function copyPath(source, destination) {
  const stat = await fs.stat(source);

  if (stat.isDirectory()) {
    await fs.mkdir(destination, { recursive: true });
    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
      await copyPath(path.join(source, entry.name), path.join(destination, entry.name));
    }
    return;
  }

  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function run(command, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${command} exited with status ${code}`));
      }
    });
  });
}

const CHUNKED_ASSETS_HELPER = `(() => {
  const nativeFetch = self.fetch.bind(self);
  const chunkStore = idbKeyval.createStore('texmirror-busytex-assets-v1', 'chunks');
  const CACHE_KEY_PREFIX = 'busytex-gzip-chunk:';
  const MAX_PARALLEL_CHUNK_LOADS = 6;
  let manifestPromise = null;
  let prunePromise = null;

  function getManifestUrl() {
    return new URL('busytex-assets.json', self.location.href).href;
  }

  async function getManifest() {
    if (!manifestPromise) {
      manifestPromise = nativeFetch(getManifestUrl(), { cache: 'force-cache' }).then(response => {
        if (!response.ok) {
          throw new Error('Failed to load BusyTeX chunk manifest: HTTP ' + response.status);
        }
        return response.json();
      }).then(manifest => {
        prunePromise = pruneStaleChunks(manifest).catch(error => {
          console.warn('[BusyTeX] Failed to prune stale IndexedDB chunks:', error);
        });
        return manifest;
      });
    }
    return manifestPromise;
  }

  function assetNameFromUrl(input) {
    const url = new URL(typeof input === 'string' ? input : input.url, self.location.href);
    return url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  }

  function chunkCacheKey(assetName, asset, chunk) {
    return [
      CACHE_KEY_PREFIX,
      assetName,
      asset.sourceSize,
      asset.sourceMtimeMs,
      asset.compressedSize,
      chunk.path,
      chunk.compressedSize
    ].join(':');
  }

  function currentChunkKeys(manifest) {
    const keys = new Set();
    for (const [assetName, asset] of Object.entries(manifest.assets || {})) {
      for (const chunk of asset.chunks || []) {
        keys.add(chunkCacheKey(assetName, asset, chunk));
      }
    }
    return keys;
  }

  async function pruneStaleChunks(manifest) {
    const validKeys = currentChunkKeys(manifest);
    const keys = await idbKeyval.keys(chunkStore);
    const staleKeys = keys.filter(key =>
      typeof key === 'string' &&
      key.startsWith(CACHE_KEY_PREFIX) &&
      !validKeys.has(key)
    );

    if (staleKeys.length > 0) {
      await idbKeyval.delMany(staleKeys, chunkStore);
    }
  }

  async function readCompressedChunk(assetName, asset, chunk, manifestUrl) {
    const key = chunkCacheKey(assetName, asset, chunk);
    const cached = await idbKeyval.get(key, chunkStore);
    if (cached instanceof ArrayBuffer && cached.byteLength === chunk.compressedSize) {
      return cached;
    }

    const chunkUrl = new URL(chunk.path, manifestUrl).href;
    const response = await nativeFetch(chunkUrl, { cache: 'force-cache' });
    if (!response.ok) {
      throw new Error('Failed to load BusyTeX chunk ' + chunk.path + ': HTTP ' + response.status);
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== chunk.compressedSize) {
      throw new Error(
        'BusyTeX chunk size mismatch for ' + chunk.path +
        ': expected ' + chunk.compressedSize + ', got ' + buffer.byteLength
      );
    }

    await idbKeyval.set(key, buffer, chunkStore);
    return buffer;
  }

  function limitParallel(maxConcurrency) {
    const queue = [];
    let active = 0;

    return task => new Promise((resolve, reject) => {
      const run = () => {
        active += 1;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            const next = queue.shift();
            if (next) next();
          });
      };

      if (active < maxConcurrency) {
        run();
      } else {
        queue.push(run);
      }
    });
  }

  function preloadCompressedChunks(assetName, asset, manifestUrl) {
    const limit = limitParallel(MAX_PARALLEL_CHUNK_LOADS);
    const chunkPromises = asset.chunks.map(chunk =>
      limit(() => readCompressedChunk(assetName, asset, chunk, manifestUrl))
    );

    Promise.all(chunkPromises).catch(() => {
      // The ordered stream loop below reports the actual error to PDF/TeX loading.
    });

    return chunkPromises;
  }

  function makeCompressedChunkStream(assetName, asset, manifestUrl) {
    return new ReadableStream({
      async start(controller) {
        try {
          await prunePromise;
          const chunkPromises = preloadCompressedChunks(assetName, asset, manifestUrl);
          for (const chunkPromise of chunkPromises) {
            controller.enqueue(new Uint8Array(await chunkPromise));
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      }
    });
  }

  async function fetchChunkedAsset(input) {
    const manifest = await getManifest();
    const name = assetNameFromUrl(input);
    const asset = manifest.assets && manifest.assets[name];
    if (!asset) return null;

    if (typeof DecompressionStream !== 'function') {
      throw new Error('This browser does not support DecompressionStream, which is required for chunked BusyTeX assets.');
    }

    const manifestUrl = getManifestUrl();
    const compressedStream = makeCompressedChunkStream(name, asset, manifestUrl);
    const body = compressedStream.pipeThrough(new DecompressionStream(asset.encoding || 'gzip'));
    return new Response(body, {
      headers: {
        'Content-Type': asset.contentType || 'application/octet-stream'
      }
    });
  }

  self.fetch = async (input, init) => {
    const chunked = await fetchChunkedAsset(input);
    if (chunked) return chunked;
    return nativeFetch(input, init);
  };
})();\n`;

const WORKER_SHIM = `importScripts('idb-keyval.js');
importScripts('busytex_chunked_assets.js');
importScripts('busytex_pipeline.js');

self.pipeline = null;

onmessage = async ({ data: { files, main_tex_path, bibtex, makeindex, rerun, busytex_wasm, busytex_js, preload_data_packages_js, data_packages_js, texmf_local, preload, verbose, driver, remote_endpoint, shell_escape, load_shell_handler_script, read_project_files, write_texlive_remote_files, write_texlive_remote_misses } }) => {
    if (busytex_wasm && busytex_js && preload_data_packages_js) {
        try {
            self.pipeline = new BusytexPipeline(busytex_js, busytex_wasm, data_packages_js, preload_data_packages_js, texmf_local, msg => postMessage({ print: msg }), applet_versions => postMessage({ initialized: applet_versions }), preload, BusytexPipeline.ScriptLoaderWorker);
        }
        catch (err) {
            postMessage({ exception: 'Exception during initialization: ' + err.toString() + '\\nStack:\\n' + err.stack });
        }
    }
    else if (load_shell_handler_script) {
        try {
            importScripts(load_shell_handler_script);
            if (self.handler_ready)
                await self.handler_ready;
            postMessage({ shell_handler_script_loaded: load_shell_handler_script });
        }
        catch (err) {
            postMessage({ exception: 'Exception loading shell handler script: ' + err.toString() + '\\nStack:\\n' + err.stack });
        }
    }
    else if (read_project_files && self.pipeline) {
        try {
            postMessage({ project_files: await self.pipeline.read_project_files(read_project_files.dir || null) });
        }
        catch (err) {
            postMessage({ exception: 'Exception reading project files: ' + err.toString() + '\\nStack:\\n' + err.stack });
        }
    }
    else if (write_texlive_remote_files && self.pipeline) {
        try {
            await self.pipeline.write_texlive_remote_files(write_texlive_remote_files);
            postMessage({ texlive_remote_written: true });
        }
        catch (err) {
            postMessage({ exception: 'Exception writing remote files: ' + err.toString() + '\\nStack:\\n' + err.stack });
        }
    }
    else if (write_texlive_remote_misses && self.pipeline) {
        try {
            await self.pipeline.write_texlive_remote_misses(write_texlive_remote_misses);
            postMessage({ texlive_remote_misses_written: true });
        }
        catch (err) {
            postMessage({ exception: 'Exception writing remote misses: ' + err.toString() + '\\nStack:\\n' + err.stack });
        }
    }
    else if (files && self.pipeline) {
        try {
            postMessage(await self.pipeline.compile(files, main_tex_path, bibtex, makeindex, rerun, verbose, driver, data_packages_js, remote_endpoint, shell_escape === true))
        }
        catch (err) {
            postMessage({ exception: 'Exception during compilation: ' + err.toString() + '\\nStack:\\n' + err.stack });
        }
    }
};\n`;

await main();
