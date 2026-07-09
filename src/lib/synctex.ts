export interface SyncTexPosition {
  line: number;
  page: number;
  x: number;
  y: number;
}

export interface SyncTexIndex {
  lines: number[];
  positionsByLine: Map<number, SyncTexPosition[]>;
  positionsByPage: Map<number, SyncTexPosition[]>;
}

export interface SyncTexPdfLocation {
  page: number;
  top: number;
  left?: number;
  pageHeight: number;
}

const SP_PER_TEX_POINT = 65536;
const PDF_POINTS_PER_TEX_POINT = 72 / 72.27;
const DEFAULT_MAGNIFICATION = 1000;
const RECORD_RE = /^[([a-zA-Z$]*(-?\d+),(-?\d+)(?::\d+)?:(-?\d+),(-?\d+)/;
const lineAnchorCache = new WeakMap<
  SyncTexPosition[],
  { pageHeight: number; anchors: Array<{ line: number; top: number }> }
>();

export async function parseSyncTexIndex(data: Uint8Array): Promise<SyncTexIndex | null> {
  const text = await inflateGzipText(data);
  const inputIds = new Set<number>();
  const positionsByLine = new Map<number, SyncTexPosition[]>();
  const seen = new Set<string>();

  let currentPage = 0;
  let unit = 1;
  let magnification = DEFAULT_MAGNIFICATION;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('Input:')) {
      const input = line.match(/^Input:(\d+):(.+)$/);
      if (input && isMainTexPath(input[2])) {
        inputIds.add(Number(input[1]));
      }
      continue;
    }

    if (line.startsWith('Unit:')) {
      unit = readPositiveNumber(line, 'Unit') ?? unit;
      continue;
    }

    if (line.startsWith('Magnification:')) {
      magnification = readPositiveNumber(line, 'Magnification') ?? magnification;
      continue;
    }

    const page = line.match(/^\{(\d+)$/);
    if (page) {
      currentPage = Number(page[1]);
      continue;
    }

    if (currentPage < 1 || inputIds.size === 0) continue;

    const record = line.match(RECORD_RE);
    if (!record) continue;

    const inputId = Number(record[1]);
    const sourceLine = Number(record[2]);
    if (!inputIds.has(inputId) || sourceLine < 1) continue;

    const x = syncCoordinateToPdfPoint(Number(record[3]), unit, magnification);
    const y = syncCoordinateToPdfPoint(Number(record[4]), unit, magnification);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

    const key = `${sourceLine}:${currentPage}:${Math.round(x * 10)}:${Math.round(y * 10)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const positions = positionsByLine.get(sourceLine) ?? [];
    positions.push({ line: sourceLine, page: currentPage, x, y });
    positionsByLine.set(sourceLine, positions);
  }

  if (positionsByLine.size === 0) return null;

  for (const positions of positionsByLine.values()) {
    positions.sort(comparePositions);
  }

  return {
    lines: [...positionsByLine.keys()].sort((a, b) => a - b),
    positionsByLine,
    positionsByPage: buildPositionsByPage(positionsByLine)
  };
}

export function findSyncTexPosition(index: SyncTexIndex, line: number): SyncTexPosition | null {
  const normalizedLine = Math.max(1, Math.round(line));
  const exact = index.positionsByLine.get(normalizedLine);
  if (exact?.length) return exact[0];

  const lines = index.lines;
  if (lines.length === 0) return null;

  const insertion = lowerBound(lines, normalizedLine);
  const previous = insertion > 0 ? lines[insertion - 1] : null;
  const next = insertion < lines.length ? lines[insertion] : null;
  const nearest =
    previous === null
      ? next
      : next === null
        ? previous
        : normalizedLine - previous <= next - normalizedLine
          ? previous
          : next;

  if (nearest === null) return null;
  return index.positionsByLine.get(nearest)?.[0] ?? null;
}

export function findSourceLineForPdfLocation(
  index: SyncTexIndex,
  location: SyncTexPdfLocation
): number | null {
  const positions = index.positionsByPage.get(location.page);
  if (!positions?.length) return null;

  const anchors = getInterpolatedLineAnchors(positions, location.pageHeight);
  if (anchors.length === 0) return null;

  const top = Math.min(Math.max(location.top, 0), location.pageHeight);
  if (top <= anchors[0].top) return anchors[0].line;

  const lastAnchor = anchors[anchors.length - 1];
  if (top >= lastAnchor.top) return lastAnchor.line;

  const nextIndex = lowerBoundAnchorTop(anchors, top);
  const previous = anchors[nextIndex - 1];
  const next = anchors[nextIndex];
  if (!previous || !next) return (previous ?? next)?.line ?? null;

  const topDelta = next.top - previous.top;
  const lineDelta = next.line - previous.line;
  if (topDelta <= 0.5 || Math.abs(lineDelta) <= 0.001) {
    return previous.line;
  }

  return previous.line + lineDelta * ((top - previous.top) / topDelta);
}

async function inflateGzipText(data: Uint8Array): Promise<string> {
  if (!('DecompressionStream' in globalThis)) {
    throw new Error('SyncTeX preview sync requires browser gzip stream support.');
  }

  const gzipBuffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(gzipBuffer).set(data);

  const stream = new Blob([gzipBuffer], { type: 'application/gzip' })
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));

  return new Response(stream).text();
}

function isMainTexPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').replaceAll('/./', '/').replace(/\/+$/, '');
  return normalized === 'main.tex' || normalized.endsWith('/main.tex');
}

function readPositiveNumber(line: string, key: string): number | null {
  const value = Number(line.slice(key.length + 1));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function syncCoordinateToPdfPoint(value: number, unit: number, magnification: number): number {
  return (value * unit * PDF_POINTS_PER_TEX_POINT * DEFAULT_MAGNIFICATION) /
    (SP_PER_TEX_POINT * magnification);
}

function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function lowerBoundAnchorTop(anchors: Array<{ line: number; top: number }>, target: number): number {
  let low = 0;
  let high = anchors.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (anchors[mid].top < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function comparePositions(lhs: SyncTexPosition, rhs: SyncTexPosition): number {
  return lhs.page - rhs.page || lhs.y - rhs.y || lhs.x - rhs.x;
}

function getInterpolatedLineAnchors(
  positions: SyncTexPosition[],
  pageHeight: number
): Array<{ line: number; top: number }> {
  const cached = lineAnchorCache.get(positions);
  if (cached && cached.pageHeight === pageHeight) {
    return cached.anchors;
  }

  const anchors = buildInterpolatedLineAnchors(positions, pageHeight);
  lineAnchorCache.set(positions, { pageHeight, anchors });
  return anchors;
}

function buildInterpolatedLineAnchors(
  positions: SyncTexPosition[],
  pageHeight: number
): Array<{ line: number; top: number }> {
  const topsByLine = new Map<number, number[]>();

  for (const position of positions) {
    const top = pageHeight - position.y;
    if (!Number.isFinite(top)) continue;

    const tops = topsByLine.get(position.line) ?? [];
    tops.push(top);
    topsByLine.set(position.line, tops);
  }

  const rawAnchors = [...topsByLine.entries()]
    .map(([line, tops]) => ({
      line,
      top: median(tops)
    }))
    .filter((anchor) => Number.isFinite(anchor.top))
    .sort((lhs, rhs) => lhs.top - rhs.top || lhs.line - rhs.line);

  const anchors: Array<{ line: number; top: number }> = [];
  let lastLine = -Infinity;

  for (const anchor of rawAnchors) {
    if (anchor.line < lastLine) continue;

    const previous = anchors[anchors.length - 1];
    if (previous && Math.abs(previous.top - anchor.top) < 0.5) {
      if (anchor.line > previous.line) {
        previous.line = anchor.line;
      }
      lastLine = Math.max(lastLine, previous.line);
      continue;
    }

    anchors.push(anchor);
    lastLine = anchor.line;
  }

  return anchors;
}

function median(values: number[]): number {
  const sorted = [...values].sort((lhs, rhs) => lhs - rhs);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function buildPositionsByPage(
  positionsByLine: Map<number, SyncTexPosition[]>
): Map<number, SyncTexPosition[]> {
  const positionsByPage = new Map<number, SyncTexPosition[]>();

  for (const positions of positionsByLine.values()) {
    for (const position of positions) {
      const pagePositions = positionsByPage.get(position.page) ?? [];
      pagePositions.push(position);
      positionsByPage.set(position.page, pagePositions);
    }
  }

  for (const positions of positionsByPage.values()) {
    positions.sort(comparePositions);
  }

  return positionsByPage;
}
