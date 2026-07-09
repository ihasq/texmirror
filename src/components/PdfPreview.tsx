import { useEffect, useRef, useState } from 'preact/hooks';
import {
  findSourceLineForPdfLocation,
  findSyncTexPosition,
  type SyncTexIndex,
  type SyncTexPosition
} from '../lib/synctex';

interface PdfPreviewProps {
  data: Uint8Array | null;
  handleRef?: HandleRef<PdfPreviewHandle>;
  onScrollSyncSample?: (sample: PdfScrollSyncSample) => void;
  syncIndex: SyncTexIndex | null;
}

export interface PdfScrollSyncSample {
  scrollTop: number;
  sourceLine: number;
}

export interface PdfPreviewHandle {
  preserveScrollForNextDocument: () => void;
  resolveSourceLineTarget: (line: number) => PdfSourceTarget | null;
  scrollToSourceTarget: (target: PdfSourceTarget) => void;
}

interface PdfScrollSnapshot {
  left: number;
  top: number;
}

export interface PdfSourceTarget {
  key: string;
  left: number;
  line: number;
  top: number;
}

interface PdfPageView {
  div?: HTMLElement;
  pdfPage?: {
    view?: number[];
  };
  viewport?: {
    height?: number;
    scale?: number;
    viewBox?: number[];
    convertToViewportPoint?: (x: number, y: number) => [number, number];
  };
}

interface PdfViewerApplication {
  eventBus?: {
    on: (eventName: string, listener: PdfEventListener, options?: unknown) => void;
    off: (eventName: string, listener: PdfEventListener) => void;
  };
  initializedPromise?: Promise<void>;
  open?: (args: { data: Uint8Array; filename?: string }) => Promise<void>;
  pdfViewer?: {
    container?: HTMLElement;
    currentPageNumber?: number;
    pagesCount: number;
    getPageView: (index: number) => PdfPageView | undefined;
  };
  viewsManager?: {
    switchView: (view: number, forceOpen?: boolean) => void;
  };
}

interface PdfViewAreaEvent {
  location?: {
    pageNumber?: number;
    top?: number;
    left?: number;
  };
  pageNumber?: number;
}

type PdfEventListener = (event?: PdfViewAreaEvent) => void;

interface PdfViewerWindow extends Window {
  PDFViewerApplication?: PdfViewerApplication;
}

interface MutableRefObject<T> {
  current: T;
}

interface HandleRef<T> {
  current: T | null;
}

const VIEWER_SRC = '/pdfjs/web/viewer.html#zoom=page-width&pagemode=none';
const PDF_FILENAME = 'main.pdf';

export function PdfPreview({
  data,
  handleRef,
  onScrollSyncSample,
  syncIndex
}: PdfPreviewProps) {
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const appRef = useRef<PdfViewerApplication | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const lastRequestedSourceLineRef = useRef(0);
  const lastTargetKeyRef = useRef('');
  const onScrollSyncSampleRef = useRef(onScrollSyncSample);
  const preservedScrollSnapshotRef = useRef<PdfScrollSnapshot | null>(null);
  const sourceSyncSuppressedRef = useRef(false);
  const syncIndexRef = useRef<SyncTexIndex | null>(syncIndex);
  const viewerGenerationRef = useRef(0);

  onScrollSyncSampleRef.current = onScrollSyncSample;
  syncIndexRef.current = syncIndex;

  useEffect(() => {
    onScrollSyncSampleRef.current = onScrollSyncSample;
  }, [onScrollSyncSample]);

  useEffect(() => {
    lastRequestedSourceLineRef.current = 0;
    lastTargetKeyRef.current = '';
  }, [syncIndex]);

  useEffect(() => {
    if (!handleRef) return;

    const handle: PdfPreviewHandle = {
      preserveScrollForNextDocument() {
        const app = appRef.current ?? getPdfViewerApplication(frameRef.current);
        const snapshot = readScrollSnapshot(app, frameRef.current);
        if (!snapshot) return;

        appRef.current = app;
        preservedScrollSnapshotRef.current = snapshot;
        sourceSyncSuppressedRef.current = true;
      },
      resolveSourceLineTarget(line: number) {
        if (sourceSyncSuppressedRef.current) {
          sourceSyncSuppressedRef.current = false;
          preservedScrollSnapshotRef.current = null;
        }

        const app = appRef.current ?? getPdfViewerApplication(frameRef.current);
        if (app?.pdfViewer?.pagesCount) {
          appRef.current = app;
          return resolveSourceLineTargetNow(
            line,
            app,
            frameRef.current,
            syncIndexRef
          );
        }

        return null;
      },
      scrollToSourceTarget(target: PdfSourceTarget) {
        const app = appRef.current ?? getPdfViewerApplication(frameRef.current);
        if (!app?.pdfViewer?.pagesCount) return;

        appRef.current = app;
        applyPdfScrollTarget(target, app, frameRef.current, lastTargetKeyRef);
      }
    };

    handleRef.current = handle;
    return () => {
      if (handleRef.current === handle) {
        handleRef.current = null;
      }
    };
  }, [handleRef]);

  useEffect(() => {
    appRef.current = null;
    lastRequestedSourceLineRef.current = 0;
    lastTargetKeyRef.current = '';
    preservedScrollSnapshotRef.current = null;
    sourceSyncSuppressedRef.current = false;
  }, [viewerUrl]);

  useEffect(() => {
    if (!data) {
      setViewerUrl(null);
      return;
    }

    setViewerUrl((current) => current ?? VIEWER_SRC);
  }, [data]);

  useEffect(() => {
    if (!data || !viewerUrl) return;

    const generation = viewerGenerationRef.current + 1;
    viewerGenerationRef.current = generation;
    let disposed = false;
    const timers: number[] = [];
    const restoreListeners: Array<() => void> = [];
    const pdfBuffer = new ArrayBuffer(data.byteLength);
    new Uint8Array(pdfBuffer).set(data);
    const snapshot = preservedScrollSnapshotRef.current ?? readScrollSnapshot(appRef.current, frameRef.current);
    preservedScrollSnapshotRef.current = null;

    if (snapshot) {
      sourceSyncSuppressedRef.current = true;
    }

    void waitForPdfViewer(frameRef.current, { requirePages: false }).then(async (app) => {
      if (disposed || generation !== viewerGenerationRef.current || !app?.open) return;

      appRef.current = app;

      try {
        await app.open({ data: new Uint8Array(pdfBuffer), filename: PDF_FILENAME });
      } catch (error) {
        if (!disposed) {
          console.error('[TeXMirror] Failed to load PDF in PDF.js viewer:', error);
        }
        return;
      }

      if (disposed || generation !== viewerGenerationRef.current) return;

      closeDocumentOutline(app);
      scheduleDocumentOutlineClose(app, timers, restoreListeners);

      if (snapshot) {
        const restore = () => {
          if (!disposed && generation === viewerGenerationRef.current) {
            restoreScrollSnapshot(app, frameRef.current, snapshot, lastTargetKeyRef);
          }
        };

        restore();
        window.requestAnimationFrame(restore);
        if (app.eventBus) {
          for (const eventName of ['pagesinit', 'pagesloaded', 'pagerendered']) {
            app.eventBus.on(eventName, restore);
            restoreListeners.push(() => app.eventBus?.off(eventName, restore));
          }
        }
        timers.push(window.setTimeout(restore, 120));
        timers.push(window.setTimeout(restore, 320));
        timers.push(window.setTimeout(restore, 700));
        timers.push(window.setTimeout(restore, 1200));
        timers.push(window.setTimeout(restore, 2200));
      } else {
        sourceSyncSuppressedRef.current = false;
      }
    });

    return () => {
      disposed = true;
      for (const timer of timers) window.clearTimeout(timer);
      for (const removeListener of restoreListeners) removeListener();
    };
  }, [data, viewerUrl]);

  useEffect(() => {
    if (!viewerUrl || !syncIndex) return;

    let cleanup: (() => void) | null = null;
    let disposed = false;
    const timers: number[] = [];

    void waitForPdfViewer(frameRef.current).then((app) => {
      if (disposed || !app?.eventBus || !app.pdfViewer) return;
      appRef.current = app;
      closeDocumentOutline(app);

      const handleViewAreaUpdate: PdfEventListener = (event) => {
        emitScrollSyncSample(app, event?.location);
      };
      const handlePageChanging: PdfEventListener = () => {
        const request = () => {
          if (!disposed) {
            emitScrollSyncSample(app, readCurrentPdfLocation(app, frameRef.current));
          }
        };

        window.requestAnimationFrame(request);
        timers.push(window.setTimeout(request, 80));
      };
      const emitScrollSyncSample = (
        app: PdfViewerApplication,
        location: PdfViewAreaEvent['location'] | null | undefined
      ) => {
        const index = syncIndexRef.current;
        const container = getViewerContainer(app, frameRef.current);
        const pageNumber = location?.pageNumber;
        const top = location?.top;
        if (!index || !container || !pageNumber || typeof top !== 'number') return;

        const pageHeight = getPageHeight(app.pdfViewer?.getPageView(pageNumber - 1));
        const line = findSourceLineForPdfLocation(index, {
          page: pageNumber,
          top,
          left: location?.left,
          pageHeight
        });
        const driverTop = container.scrollTop;
        if (!line) return;
        if (line === lastRequestedSourceLineRef.current) return;

        lastRequestedSourceLineRef.current = line;
        onScrollSyncSampleRef.current?.({
          scrollTop: driverTop,
          sourceLine: line
        });
      };

      app.eventBus.on('updateviewarea', handleViewAreaUpdate);
      app.eventBus.on('pagechanging', handlePageChanging);
      cleanup = () => {
        app.eventBus?.off('updateviewarea', handleViewAreaUpdate);
        app.eventBus?.off('pagechanging', handlePageChanging);
      };
    });

    return () => {
      disposed = true;
      for (const timer of timers) window.clearTimeout(timer);
      cleanup?.();
    };
  }, [syncIndex, viewerUrl]);

  return (
    <div className="pdf-frame-shell">
      {!viewerUrl ? (
        <div className="preview-empty">
          <strong>No PDF yet</strong>
          <span>Run a successful compile to show the document here.</span>
        </div>
      ) : null}
      {viewerUrl ? (
        <iframe
          className="pdf-frame"
          ref={frameRef}
          src={viewerUrl}
          title="PDF.js preview"
        />
      ) : null}
    </div>
  );
}

function resolveSourceLineTargetNow(
  line: number,
  app: PdfViewerApplication,
  frame: HTMLIFrameElement | null,
  syncIndexRef: MutableRefObject<SyncTexIndex | null>
): PdfSourceTarget | null {
  if (!frame?.src) return null;

  const index = syncIndexRef.current;
  if (!index || line < 1) return null;

  const normalizedLine = Math.max(1, Math.round(line));
  const firstSyncedLine = index.lines[0];
  if (firstSyncedLine && normalizedLine <= firstSyncedLine) {
    return getDocumentStartTarget(normalizedLine);
  }

  const position = findSyncTexPosition(index, normalizedLine);
  return position ? getScrollTarget(app, frame, position, normalizedLine) : null;
}

function getDocumentStartTarget(line: number): PdfSourceTarget {
  return {
    key: 'document-start',
    left: 0,
    line,
    top: 0
  };
}

function applyPdfScrollTarget(
  target: PdfSourceTarget,
  app: PdfViewerApplication,
  frame: HTMLIFrameElement | null,
  lastTargetKeyRef: MutableRefObject<string>
): void {
  const container = getViewerContainer(app, frame);
  if (!container) return;

  const alreadyAtTarget =
    Math.abs(container.scrollTop - target.top) < 1 &&
    Math.abs(container.scrollLeft - target.left) < 1;
  if (target.key === lastTargetKeyRef.current && alreadyAtTarget) return;

  lastTargetKeyRef.current = target.key;

  container.scrollTop = clamp(target.top, 0, Math.max(0, container.scrollHeight - container.clientHeight));
  if (container.scrollWidth > container.clientWidth + 1) {
    container.scrollLeft = clamp(target.left, 0, Math.max(0, container.scrollWidth - container.clientWidth));
  }
}

async function waitForPdfViewer(
  frame: HTMLIFrameElement | null,
  options: { requirePages?: boolean } = {}
): Promise<PdfViewerApplication | null> {
  const deadline = performance.now() + 10000;
  const requirePages = options.requirePages ?? true;

  while (performance.now() < deadline) {
    const app = getPdfViewerApplication(frame);

    if (app) {
      if (app.initializedPromise) {
        await Promise.race([app.initializedPromise.catch(() => undefined), delay(120)]);
      }

      if (app.pdfViewer && (!requirePages || app.pdfViewer.pagesCount)) {
        closeDocumentOutline(app);
        return app;
      }
    }

    await delay(80);
  }

  return null;
}

function getPdfViewerApplication(frame: HTMLIFrameElement | null): PdfViewerApplication | null {
  return (frame?.contentWindow as PdfViewerWindow | null)?.PDFViewerApplication ?? null;
}

function readScrollSnapshot(
  app: PdfViewerApplication | null,
  frame: HTMLIFrameElement | null
): PdfScrollSnapshot | null {
  const container = app ? getViewerContainer(app, frame) : null;
  if (!container || !app?.pdfViewer?.pagesCount) return null;

  return {
    top: container.scrollTop,
    left: container.scrollLeft
  };
}

function readCurrentPdfLocation(
  app: PdfViewerApplication,
  frame: HTMLIFrameElement | null
): PdfViewAreaEvent['location'] | null {
  const pdfViewer = app.pdfViewer;
  const container = getViewerContainer(app, frame);
  const pageNumber = pdfViewer?.currentPageNumber;
  if (!pdfViewer || !container || !pageNumber) return null;

  const pageView = pdfViewer.getPageView(pageNumber - 1);
  const pageDiv = pageView?.div;
  if (!pageDiv) return null;

  const pageOffset = getOffsetWithin(pageDiv, container);
  const scale = pageView.viewport?.scale || 1;
  const pageHeight = getPageHeight(pageView);
  const top = clamp((container.scrollTop - pageOffset.top) / scale, 0, pageHeight);
  const left = Math.max(0, (container.scrollLeft - pageOffset.left) / scale);

  return { pageNumber, top, left };
}

function restoreScrollSnapshot(
  app: PdfViewerApplication,
  frame: HTMLIFrameElement | null,
  snapshot: PdfScrollSnapshot,
  lastTargetKeyRef: MutableRefObject<string>
): void {
  const container = getViewerContainer(app, frame);
  if (!container) return;

  container.scrollTop = clamp(snapshot.top, 0, Math.max(0, container.scrollHeight - container.clientHeight));
  container.scrollLeft = clamp(snapshot.left, 0, Math.max(0, container.scrollWidth - container.clientWidth));
  lastTargetKeyRef.current = `preserved:${Math.round(container.scrollTop)}:${Math.round(container.scrollLeft)}`;
}

function closeDocumentOutline(app: PdfViewerApplication): void {
  app.viewsManager?.switchView(0);
}

function scheduleDocumentOutlineClose(
  app: PdfViewerApplication,
  timers: number[],
  cleanupListeners: Array<() => void>
): void {
  const close = () => closeDocumentOutline(app);

  close();

  if (app.eventBus) {
    for (const eventName of ['documentloaded', 'pagesinit', 'pagesloaded', 'outlineloaded']) {
      app.eventBus.on(eventName, close);
      cleanupListeners.push(() => app.eventBus?.off(eventName, close));
    }
  }

  for (const delayMs of [80, 180, 420, 900, 1800]) {
    timers.push(window.setTimeout(close, delayMs));
  }
}

function getScrollTarget(
  app: PdfViewerApplication,
  frame: HTMLIFrameElement | null,
  position: SyncTexPosition,
  line: number
): PdfSourceTarget | null {
  const pdfViewer = app.pdfViewer;
  const container = getViewerContainer(app, frame);
  const pageView = pdfViewer?.getPageView(position.page - 1);
  const pageDiv = pageView?.div;
  const viewport = pageView?.viewport;
  if (!pdfViewer || !container || !pageDiv || !viewport?.convertToViewportPoint) return null;

  const pageHeight = getPageHeight(pageView);
  const yFromBottom = clamp(pageHeight - position.y, 0, pageHeight);
  const x = Math.max(0, position.x - 12);
  const [viewportX, viewportY] = viewport.convertToViewportPoint(x, yFromBottom);
  const pageOffset = getOffsetWithin(pageDiv, container);
  const top = pageOffset.top + viewportY - container.clientHeight * 0.46;
  const left = pageOffset.left + viewportX - container.clientWidth * 0.36;

  return {
    key: positionKey(position),
    top: clamp(top, 0, Math.max(0, container.scrollHeight - container.clientHeight)),
    left: clamp(left, 0, Math.max(0, container.scrollWidth - container.clientWidth)),
    line
  };
}

function getViewerContainer(
  app: PdfViewerApplication,
  frame: HTMLIFrameElement | null
): HTMLElement | null {
  return app.pdfViewer?.container ??
    frame?.contentDocument?.getElementById('viewerContainer') ??
    null;
}

function getOffsetWithin(element: HTMLElement, ancestor: HTMLElement): { top: number; left: number } {
  let top = element.offsetTop + element.clientTop;
  let left = element.offsetLeft + element.clientLeft;
  let parent = element.offsetParent as HTMLElement | null;

  while (parent && parent !== ancestor) {
    top += parent.offsetTop + parent.clientTop;
    left += parent.offsetLeft + parent.clientLeft;
    parent = parent.offsetParent as HTMLElement | null;
  }

  if (parent === ancestor) {
    return { top, left };
  }

  const elementRect = element.getBoundingClientRect();
  const ancestorRect = ancestor.getBoundingClientRect();
  return {
    top: elementRect.top - ancestorRect.top + ancestor.scrollTop,
    left: elementRect.left - ancestorRect.left + ancestor.scrollLeft
  };
}

function getPageHeight(pageView: PdfPageView | undefined): number {
  const view = pageView?.pdfPage?.view ?? pageView?.viewport?.viewBox;
  if (view && view.length >= 4) {
    return Math.abs(view[3] - view[1]);
  }

  const viewport = pageView?.viewport;
  if (viewport?.height && viewport.scale) {
    return viewport.height / viewport.scale;
  }

  return 792;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function positionKey(position: SyncTexPosition): string {
  return `${position.page}:${Math.round(position.x * 10)}:${Math.round(position.y * 10)}`;
}
