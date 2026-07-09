import { useEffect, useRef, useState } from 'preact/hooks';
import {
  findSourceLineForPdfLocation,
  findSyncTexPosition,
  type SyncTexIndex,
  type SyncTexPosition
} from '../lib/synctex';

interface PdfPreviewProps {
  data: Uint8Array | null;
  getCurrentSourceLine?: () => number;
  handleRef?: HandleRef<PdfPreviewHandle>;
  onSourceLineRequest?: (line: number) => void;
  reverseSyncEnabled: boolean;
  syncIndex: SyncTexIndex | null;
}

export interface PdfPreviewHandle {
  scrollToSourceLine: (line: number) => void;
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
    on: (eventName: string, listener: (event: PdfViewAreaEvent) => void) => void;
    off: (eventName: string, listener: (event: PdfViewAreaEvent) => void) => void;
  };
  initializedPromise?: Promise<void>;
  pdfViewer?: {
    container?: HTMLElement;
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
}

interface PdfViewerWindow extends Window {
  PDFViewerApplication?: PdfViewerApplication;
}

interface MutableRefObject<T> {
  current: T;
}

interface HandleRef<T> {
  current: T | null;
}

export function PdfPreview({
  data,
  getCurrentSourceLine,
  handleRef,
  onSourceLineRequest,
  reverseSyncEnabled,
  syncIndex
}: PdfPreviewProps) {
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const appRef = useRef<PdfViewerApplication | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const getCurrentSourceLineRef = useRef(getCurrentSourceLine);
  const lastRequestedSourceLineRef = useRef(0);
  const lastTargetKeyRef = useRef('');
  const onSourceLineRequestRef = useRef(onSourceLineRequest);
  const reverseSyncEnabledRef = useRef(reverseSyncEnabled);
  const syncIndexRef = useRef<SyncTexIndex | null>(syncIndex);
  const waitPromiseRef = useRef<Promise<PdfViewerApplication | null> | null>(null);

  getCurrentSourceLineRef.current = getCurrentSourceLine;
  onSourceLineRequestRef.current = onSourceLineRequest;
  reverseSyncEnabledRef.current = reverseSyncEnabled;
  syncIndexRef.current = syncIndex;

  useEffect(() => {
    getCurrentSourceLineRef.current = getCurrentSourceLine;
  }, [getCurrentSourceLine]);

  useEffect(() => {
    onSourceLineRequestRef.current = onSourceLineRequest;
  }, [onSourceLineRequest]);

  useEffect(() => {
    reverseSyncEnabledRef.current = reverseSyncEnabled;
  }, [reverseSyncEnabled]);

  useEffect(() => {
    lastRequestedSourceLineRef.current = 0;
    lastTargetKeyRef.current = '';
  }, [syncIndex]);

  useEffect(() => {
    if (!handleRef) return;

    const handle: PdfPreviewHandle = {
      scrollToSourceLine(line: number) {
        const app = appRef.current ?? getPdfViewerApplication(frameRef.current);
        if (app?.pdfViewer?.pagesCount) {
          appRef.current = app;
          scrollToSourceLineNow(line, app, frameRef.current, syncIndexRef, lastTargetKeyRef);
          return;
        }

        if (!waitPromiseRef.current) {
          waitPromiseRef.current = waitForPdfViewer(frameRef.current).then((nextApp) => {
            waitPromiseRef.current = null;
            if (nextApp?.pdfViewer?.pagesCount) {
              appRef.current = nextApp;
              scrollToSourceLineNow(line, nextApp, frameRef.current, syncIndexRef, lastTargetKeyRef);
            }
            return nextApp;
          });
        }
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
    waitPromiseRef.current = null;
  }, [viewerUrl]);

  useEffect(() => {
    if (!data) {
      setViewerUrl(null);
      return;
    }

    const pdfBuffer = new ArrayBuffer(data.byteLength);
    new Uint8Array(pdfBuffer).set(data);
    const url = URL.createObjectURL(new Blob([pdfBuffer], { type: 'application/pdf' }));
    setViewerUrl(`/pdfjs/web/viewer.html?file=${encodeURIComponent(url)}#zoom=page-width&pagemode=none`);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [data]);

  useEffect(() => {
    if (!viewerUrl || !syncIndex) return;

    let cleanup: (() => void) | null = null;
    let disposed = false;
    const timers: number[] = [];

    void waitForPdfViewer(frameRef.current).then((app) => {
      if (disposed || !app?.eventBus || !app.pdfViewer) return;
      appRef.current = app;
      closeDocumentOutline(app);

      const scrollToCurrentSourceLine = () => {
        if (disposed || reverseSyncEnabledRef.current) return;
        scrollToSourceLineNow(
          getCurrentSourceLineRef.current?.() ?? 1,
          app,
          frameRef.current,
          syncIndexRef,
          lastTargetKeyRef
        );
      };

      scrollToCurrentSourceLine();
      timers.push(window.setTimeout(scrollToCurrentSourceLine, 180));
      timers.push(window.setTimeout(scrollToCurrentSourceLine, 600));

      const handleViewAreaUpdate = (event: PdfViewAreaEvent) => {
        if (!reverseSyncEnabledRef.current) return;

        const index = syncIndexRef.current;
        const location = event.location;
        const pageNumber = location?.pageNumber;
        const top = location?.top;
        if (!index || !pageNumber || typeof top !== 'number') return;

        const pageHeight = getPageHeight(app.pdfViewer?.getPageView(pageNumber - 1));
        const line = findSourceLineForPdfLocation(index, {
          page: pageNumber,
          top,
          left: location?.left,
          pageHeight
        });
        if (!line || line === lastRequestedSourceLineRef.current) return;

        lastRequestedSourceLineRef.current = line;
        onSourceLineRequestRef.current?.(line);
      };

      app.eventBus.on('updateviewarea', handleViewAreaUpdate);
      cleanup = () => app.eventBus?.off('updateviewarea', handleViewAreaUpdate);
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
          key={viewerUrl}
          ref={frameRef}
          src={viewerUrl}
          title="PDF.js preview"
        />
      ) : null}
    </div>
  );
}

function scrollToSourceLineNow(
  line: number,
  app: PdfViewerApplication,
  frame: HTMLIFrameElement | null,
  syncIndexRef: MutableRefObject<SyncTexIndex | null>,
  lastTargetKeyRef: MutableRefObject<string>
): void {
  if (!frame?.src) return;

  const index = syncIndexRef.current;
  if (!index || line < 1) return;

  const normalizedLine = Math.max(1, Math.round(line));
  const firstSyncedLine = index.lines[0];
  if (firstSyncedLine && normalizedLine <= firstSyncedLine) {
    scrollToDocumentStart(app, frame, lastTargetKeyRef);
    return;
  }

  const position = findSyncTexPosition(index, normalizedLine);
  if (!position) return;

  scrollToSyncTexPosition(app, frame, position, lastTargetKeyRef);
}

function scrollToDocumentStart(
  app: PdfViewerApplication,
  frame: HTMLIFrameElement | null,
  lastTargetKeyRef: MutableRefObject<string>
): void {
  const container = getViewerContainer(app, frame);
  if (!container) return;

  if (lastTargetKeyRef.current === 'document-start' && container.scrollTop === 0) return;

  lastTargetKeyRef.current = 'document-start';
  container.scrollTop = 0;
  container.scrollLeft = 0;
}

function scrollToSyncTexPosition(
  app: PdfViewerApplication,
  frame: HTMLIFrameElement | null,
  position: SyncTexPosition,
  lastTargetKeyRef: MutableRefObject<string>
): void {
  const target = getScrollTarget(app, frame, position);
  if (!target) return;

  const alreadyAtTarget =
    Math.abs(target.container.scrollTop - target.top) < 1 &&
    Math.abs(target.container.scrollLeft - target.left) < 1;
  if (target.key === lastTargetKeyRef.current && alreadyAtTarget) return;

  lastTargetKeyRef.current = target.key;

  target.container.scrollTop = target.top;
  if (target.container.scrollWidth > target.container.clientWidth + 1) {
    target.container.scrollLeft = target.left;
  }
}

async function waitForPdfViewer(frame: HTMLIFrameElement | null): Promise<PdfViewerApplication | null> {
  const deadline = performance.now() + 10000;

  while (performance.now() < deadline) {
    const app = getPdfViewerApplication(frame);

    if (app) {
      if (app.initializedPromise) {
        await Promise.race([app.initializedPromise.catch(() => undefined), delay(120)]);
      }

      if (app.pdfViewer?.pagesCount) {
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

function closeDocumentOutline(app: PdfViewerApplication): void {
  app.viewsManager?.switchView(0);
}

function getScrollTarget(
  app: PdfViewerApplication,
  frame: HTMLIFrameElement | null,
  position: SyncTexPosition
): { key: string; top: number; left: number; container: HTMLElement } | null {
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
    container
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
