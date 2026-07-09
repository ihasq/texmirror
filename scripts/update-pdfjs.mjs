#!/usr/bin/env node

import { createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PDFJS_DIR = path.join(ROOT, 'public', 'pdfjs');
const REGISTRY_URL = 'https://registry.npmjs.org/pdfjs-dist/latest';
const USER_AGENT = 'texmirror-update-pdfjs';
const FORCE = process.argv.includes('--force');

const metadata = await fetchJson(REGISTRY_URL);
const version = metadata.version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
  throw new Error(`Unexpected pdfjs-dist version: ${String(version)}`);
}

const currentVersion = await readCurrentVersion();
if (!FORCE && currentVersion === version) {
  console.log(`PDF.js viewer is already current: ${version}`);
  process.exit(0);
}

const releaseUrl = `https://github.com/mozilla/pdf.js/releases/download/v${version}/pdfjs-${version}-dist.zip`;
const workDir = await fs.mkdtemp(path.join(tmpdir(), 'texmirror-pdfjs-'));

try {
  const zipPath = path.join(workDir, `pdfjs-${version}-dist.zip`);
  const extractDir = path.join(workDir, 'extract');
  const nextDir = path.join(workDir, 'pdfjs');

  console.log(`Downloading PDF.js ${version} from ${releaseUrl}`);
  await downloadFile(releaseUrl, zipPath);
  await fs.mkdir(extractDir, { recursive: true });
  await run('unzip', ['-q', zipPath, '-d', extractDir]);

  const sourceRoot = await findDistributionRoot(extractDir);
  await fs.mkdir(nextDir, { recursive: true });
  await copyPath(path.join(sourceRoot, 'LICENSE'), path.join(nextDir, 'LICENSE'));
  await copyPath(path.join(sourceRoot, 'build'), path.join(nextDir, 'build'));
  await copyPath(path.join(sourceRoot, 'web'), path.join(nextDir, 'web'));
  await writeReadme(nextDir, version, releaseUrl);

  await fs.rm(PDFJS_DIR, { recursive: true, force: true });
  await fs.mkdir(path.dirname(PDFJS_DIR), { recursive: true });
  await fs.rename(nextDir, PDFJS_DIR);

  console.log(`Updated PDF.js viewer from ${currentVersion ?? 'none'} to ${version}`);
} finally {
  await fs.rm(workDir, { recursive: true, force: true });
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return response.json();
}

async function downloadFile(url, destination) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT
    }
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function readCurrentVersion() {
  try {
    const readme = await fs.readFile(path.join(PDFJS_DIR, 'README.md'), 'utf8');
    return readme.match(/PDF\.js\s+([0-9][^\s,]*)/)?.[1] ?? null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function findDistributionRoot(directory) {
  const queue = [directory];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    if (
      await exists(path.join(current, 'build', 'pdf.mjs')) &&
      await exists(path.join(current, 'web', 'viewer.html'))
    ) {
      return current;
    }

    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        queue.push(path.join(current, entry.name));
      }
    }
  }

  throw new Error('Could not find PDF.js distribution root in downloaded archive.');
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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

  if (source.endsWith('.map')) return;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function writeReadme(directory, version, releaseUrl) {
  const readme = `# PDF.js viewer

This directory is a copied runtime distribution of PDF.js ${version}, taken from:

${releaseUrl}

It is intentionally vendored as static assets rather than included as a git
submodule. Source maps are omitted; runtime viewer assets, licenses, fonts,
CMaps, ICC profiles, and WASM helpers are included.
`;

  await fs.writeFile(path.join(directory, 'README.md'), readme);
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with status ${code}`));
      }
    });
  });
}
