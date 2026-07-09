import {
  CheckCircle2,
  FileText,
  FolderOpen,
  LoaderCircle,
  Play,
  Save,
  TerminalSquare,
  XCircle
} from 'lucide-preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { EditorPane, type EditorPaneHandle, type EditorScrollSample } from './components/EditorPane';
import { PdfPreview, type PdfPreviewHandle, type PdfScrollSyncSample } from './components/PdfPreview';
import { DEFAULT_TEX } from './lib/examples';
import {
  ScrollSyncDriver,
  type ScrollSyncCheckpoint,
  type ScrollSyncCheckpointPair
} from './lib/scrollSyncDriver';
import {
  BrowserTexCompiler,
  type CompileRequest,
  type TexEngine,
  toCompileSuccess
} from './lib/texCompiler';
import { parseSyncTexIndex, type SyncTexIndex } from './lib/synctex';

type CompileState = 'idle' | 'initializing' | 'compiling' | 'success' | 'error';
type ScrollOwner = 'editor' | 'preview';

const STORAGE_KEY = 'texmirror.source';
const ENGINE_STORAGE_KEY = 'texmirror.engine';
const RERUN_STORAGE_KEY = 'texmirror.rerun';
const AUTO_COMPILE_STORAGE_KEY = 'texmirror.autoCompile';
const DEBOUNCE_MS = 900;
const DEFAULT_SAVE_NAME = 'document.tex';
const STRUCTURAL_CHECKPOINT_COMMAND_RE =
  /\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?:\s*\[[^\]]*])?\s*\{|\\begin\s*\{/;
const TEX_FILE_TYPES: FilePickerAcceptType[] = [
  {
    description: 'TeX source',
    accept: {
      'text/plain': ['.tex', '.latex', '.ltx', '.txt']
    }
  }
];

const appShellClassName =
  'app-shell grid h-dvh min-h-dvh min-w-80 grid-rows-[minmax(0,1fr)_auto] bg-slate-100 font-sans text-neutral-800 antialiased [color-scheme:light] [font-synthesis:none] [text-rendering:optimizeLegibility]';
const workspaceClassName =
  'workspace grid min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(320px,1fr)_minmax(320px,1fr)] min-[981px]:grid-cols-[minmax(0,1fr)_minmax(360px,1fr)] min-[981px]:grid-rows-none';
const paneClassName =
  'pane relative grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] bg-white';
const editorPaneClassName =
  `${paneClassName} editor-pane border-b border-slate-300 min-[981px]:border-r min-[981px]:border-b-0`;
const previewPaneClassName =
  'pane preview-pane relative grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] bg-slate-200';
const paneHeaderClassName =
  'pane-header editor-header flex min-h-[42px] flex-wrap items-center justify-between gap-3 border-b border-slate-300 px-3 py-2 text-[13px] font-semibold text-slate-700';
const paneTitleClassName = 'pane-title inline-flex min-h-[34px] min-w-0 items-center gap-2.5';
const fileActionsClassName = 'file-actions inline-flex flex-none items-center gap-1.5';
const fileNameClassName =
  'file-name max-w-[120px] overflow-hidden text-ellipsis whitespace-nowrap text-neutral-800 min-[641px]:max-w-[220px]';
const toolbarClassName =
  'toolbar editor-toolbar flex w-full flex-1 basis-[520px] flex-wrap items-center justify-start gap-2 min-[981px]:w-auto min-[981px]:justify-end';
const iconButtonClassName =
  'tool-button inline-flex min-h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-[7px] border border-slate-300 bg-white text-neutral-800 disabled:cursor-not-allowed disabled:opacity-[0.45]';
const selectControlClassName =
  'select-control inline-flex min-h-[34px] w-full items-center justify-between gap-[7px] rounded-[7px] border border-slate-300 bg-white pl-2.5 text-[13px] text-slate-700 min-[641px]:w-auto';
const selectClassName =
  'h-8 flex-1 border-0 border-l border-slate-300 bg-white py-0 pr-7 pl-2.5 text-neutral-800 min-[641px]:flex-none';
const toggleClassName =
  'toggle inline-flex min-h-[34px] items-center gap-[7px] rounded-[7px] border border-slate-300 bg-white px-2.5 text-[13px] text-slate-700';
const checkboxClassName = 'accent-teal-700';
const commandButtonClassName =
  'command-button inline-flex min-h-[34px] cursor-pointer items-center justify-center gap-[7px] rounded-[7px] border border-teal-700 bg-teal-700 px-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-[0.45]';
const toolbarIconClassName = 'size-[17px] shrink-0';
const statusIconClassName = 'size-[15px] shrink-0';
const logToggleIconClassName = 'size-4 shrink-0';
const logToggleClassName =
  'log-toggle flex min-h-9 w-full cursor-pointer items-center gap-2 border-b border-slate-200 bg-white px-3 text-slate-700';
const logPreClassName =
  'm-0 overflow-auto bg-neutral-800 px-3 py-2.5 font-mono text-xs leading-6 whitespace-pre-wrap text-slate-100';
const syncGateOverlayClassName = 'sync-gate-overlay absolute inset-0 z-10 bg-transparent';

function App() {
  const [source, setSource] = useState(() => localStorage.getItem(STORAGE_KEY) ?? DEFAULT_TEX);
  const [engine, setEngine] = useState<TexEngine>(() =>
    readStoredTexEngine(ENGINE_STORAGE_KEY, 'pdflatex')
  );
  const [rerun, setRerun] = useState(() => readStoredBoolean(RERUN_STORAGE_KEY, true));
  const [autoCompile, setAutoCompile] = useState(() =>
    readStoredBoolean(AUTO_COMPILE_STORAGE_KEY, true)
  );
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [log, setLog] = useState('Ready.');
  const [state, setState] = useState<CompileState>('idle');
  const [queued, setQueued] = useState(false);
  const [assetProgress, setAssetProgress] = useState<number | null>(null);
  const [showLog, setShowLog] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [syncIndex, setSyncIndex] = useState<SyncTexIndex | null>(null);
  const [scrollOwner, setScrollOwnerState] = useState<ScrollOwner>('editor');

  const compilerRef = useRef<BrowserTexCompiler | null>(null);
  const compilingRef = useRef(false);
  const queuedRef = useRef(false);
  const fileHandleRef = useRef<FileSystemFileHandle | null>(null);
  const editorPaneRef = useRef<EditorPaneHandle | null>(null);
  const pdfPreviewRef = useRef<PdfPreviewHandle | null>(null);
  const scrollSyncDriverRef = useRef(new ScrollSyncDriver());
  const editorScrollSampleRef = useRef<EditorScrollSample>({ centerLine: 1, scrollRange: 0, scrollTop: 0 });
  const sourceRef = useRef(source);
  const optionsRef = useRef({ engine, rerun });
  const canUseFileSystem = typeof window.showOpenFilePicker === 'function' &&
    typeof window.showSaveFilePicker === 'function';
  const structuralCheckpointLines = useMemo(
    () => resolveStructuralCheckpointLines(source, syncIndex),
    [source, syncIndex]
  );

  useEffect(() => {
    sourceRef.current = source;
    localStorage.setItem(STORAGE_KEY, source);
  }, [source]);

  useEffect(() => {
    optionsRef.current = { engine, rerun };
    localStorage.setItem(ENGINE_STORAGE_KEY, engine);
    localStorage.setItem(RERUN_STORAGE_KEY, String(rerun));
  }, [engine, rerun]);

  useEffect(() => {
    localStorage.setItem(AUTO_COMPILE_STORAGE_KEY, String(autoCompile));
  }, [autoCompile]);

  useEffect(() => {
    scrollSyncDriverRef.current.reset();
  }, [syncIndex]);

  useEffect(() => {
    return () => {
      compilerRef.current?.terminate();
    };
  }, []);

  const runCompile = useCallback(async () => {
    queuedRef.current = true;
    setQueued(compilingRef.current);

    if (compilingRef.current) return;

    compilingRef.current = true;

    while (queuedRef.current) {
      queuedRef.current = false;
      setQueued(false);

      const request: CompileRequest = {
        source: sourceRef.current,
        engine: optionsRef.current.engine,
        rerun: optionsRef.current.rerun
      };

      const startedAt = performance.now();
      const firstCompile = !compilerRef.current;

      pdfPreviewRef.current?.preserveScrollForNextDocument();
      setState(firstCompile ? 'initializing' : 'compiling');
      setAssetProgress(firstCompile ? 0 : null);
      setSyncIndex(null);
      setLog(firstCompile ? 'Initializing BusyTeX WASM runtime...' : 'Compiling...');

      try {
        if (!compilerRef.current) {
          compilerRef.current = new BrowserTexCompiler((progress) => {
            setAssetProgress(progress.percent);
          });
        }

        const result = await compilerRef.current.compile(request);
        const success = toCompileSuccess(result);
        const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
        const [nextSyncIndex, syncWarning] = await readSyncTexIndex(success.synctex);

        setPdfData(success.pdf);
        setSyncIndex(nextSyncIndex);
        setState('success');
        setAssetProgress(null);
        setLog(`${formatCompileLog(success.log, success.exitCode, elapsed)}${syncWarning}`);
      } catch (compileError) {
        setSyncIndex(null);
        setState('error');
        setAssetProgress(null);
        setLog(compileError instanceof Error ? compileError.message : String(compileError));
      }
    }

    compilingRef.current = false;
  }, []);

  useEffect(() => {
    if (!autoCompile) return;

    const timer = window.setTimeout(() => {
      void runCompile();
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [autoCompile, source, engine, rerun, runCompile]);

  const status = useMemo(() => {
    if (queued) return { label: 'Queued', icon: <LoaderCircle className={`${statusIconClassName} animate-spin`} /> };
    if (state === 'initializing') {
      return { label: 'Initializing', icon: <LoaderCircle className={`${statusIconClassName} animate-spin`} /> };
    }
    if (state === 'compiling') {
      return { label: 'Compiling', icon: <LoaderCircle className={`${statusIconClassName} animate-spin`} /> };
    }
    if (state === 'success') return { label: 'Ready', icon: <CheckCircle2 className={statusIconClassName} /> };
    if (state === 'error') return { label: 'Error', icon: <XCircle className={statusIconClassName} /> };
    return { label: 'Idle', icon: <FileText className={statusIconClassName} /> };
  }, [queued, state]);

  const isBusy = state === 'initializing' || state === 'compiling';

  const openTexFile = useCallback(async () => {
    if (!window.showOpenFilePicker) {
      setLog('File System Access API is not available in this browser.');
      return;
    }

    try {
      const [handle] = await window.showOpenFilePicker({
        excludeAcceptAllOption: false,
        multiple: false,
        types: TEX_FILE_TYPES
      });
      if (!handle) return;

      const file = await handle.getFile();
      const text = await file.text();

      fileHandleRef.current = handle;
      setFileName(handle.name || file.name);
      setSource(text);
      setLog(`Opened ${handle.name || file.name}.`);
    } catch (error) {
      if (!isPickerAbort(error)) {
        setLog(`Open failed: ${formatError(error)}`);
      }
    }
  }, []);

  const saveTexFile = useCallback(async () => {
    let handle = fileHandleRef.current;

    try {
      if (!handle) {
        if (!window.showSaveFilePicker) {
          setLog('File System Access API is not available in this browser.');
          return;
        }

        handle = await window.showSaveFilePicker({
          excludeAcceptAllOption: false,
          suggestedName: fileName ?? DEFAULT_SAVE_NAME,
          types: TEX_FILE_TYPES
        });
      }

      const writable = await handle.createWritable();
      await writable.write(sourceRef.current);
      await writable.close();

      fileHandleRef.current = handle;
      setFileName(handle.name);
      setLog(`Saved ${handle.name}.`);
    } catch (error) {
      if (!isPickerAbort(error)) {
        setLog(`Save failed: ${formatError(error)}`);
      }
    }
  }, [fileName]);

  const setScrollOwner = useCallback((owner: ScrollOwner) => {
    scrollSyncDriverRef.current.setOwner(owner);
    setScrollOwnerState((current) => current === owner ? current : owner);
  }, []);

  const handleEditorScrollFrame = useCallback((sample: EditorScrollSample) => {
    editorScrollSampleRef.current = sample;
    scrollSyncDriverRef.current.followEditor(sample, {
      resolveScrollCheckpoints: (ownerTop, owner) => resolveScrollSyncCheckpoints(ownerTop, owner, structuralCheckpointLines, editorPaneRef.current, pdfPreviewRef.current),
      resolveSourceLineTarget: (line) => pdfPreviewRef.current?.resolveSourceLineTarget(line) ?? null,
      scrollToDisplacement: (displacement) => pdfPreviewRef.current?.scrollToDisplacement(displacement),
      scrollToScrollTop: (top) => pdfPreviewRef.current?.scrollToScrollTop(top),
      scrollToSourceTarget: (target) => pdfPreviewRef.current?.scrollToSourceTarget(target)
    });
  }, [structuralCheckpointLines]);

  const handlePdfScrollSyncSample = useCallback((sample: PdfScrollSyncSample) => {
    scrollSyncDriverRef.current.followPreview(sample, {
      resolveScrollCheckpoints: (ownerTop, owner) => resolveScrollSyncCheckpoints(ownerTop, owner, structuralCheckpointLines, editorPaneRef.current, pdfPreviewRef.current),
      scrollToDisplacement: (displacement) => editorPaneRef.current?.scrollToDisplacement(displacement),
      scrollToScrollTop: (top) => editorPaneRef.current?.scrollToScrollTop(top),
      scrollToSourceLine: (line) => editorPaneRef.current?.scrollToSourceLine(line)
    });
  }, [structuralCheckpointLines]);

  return (
    <div className={appShellClassName}>
      <main className={workspaceClassName}>
        <section
          className={editorPaneClassName}
          aria-label="LaTeX source editor"
        >
          {scrollOwner !== 'editor' ? (
            <SyncGateOverlay onActivate={() => setScrollOwner('editor')} />
          ) : null}
          <div className={paneHeaderClassName}>
            <div className={paneTitleClassName}>
              <div className={fileActionsClassName} aria-label="File actions">
                <button
                  aria-label="Open TeX file"
                  className={iconButtonClassName}
                  disabled={!canUseFileSystem}
                  onClick={openTexFile}
                  title="Open TeX file"
                  type="button"
                >
                  <FolderOpen aria-hidden="true" className={toolbarIconClassName} />
                </button>
                <button
                  aria-label="Save TeX file"
                  className={iconButtonClassName}
                  disabled={!canUseFileSystem}
                  onClick={saveTexFile}
                  title="Save TeX file"
                  type="button"
                >
                  <Save aria-hidden="true" className={toolbarIconClassName} />
                </button>
              </div>
              {fileName ? <span className={fileNameClassName}>{fileName}</span> : null}
            </div>

            <div className={toolbarClassName}>
              <label className={selectControlClassName}>
                <span>LaTeX</span>
                <select
                  aria-label="LaTeX engine"
                  className={selectClassName}
                  onChange={(event) => setEngine((event.currentTarget as HTMLSelectElement).value as TexEngine)}
                  value={engine}
                >
                  <option value="pdflatex">pdfLaTeX</option>
                  <option value="xelatex">XeLaTeX</option>
                  <option value="lualatex">LuaLaTeX</option>
                </select>
              </label>

              <label className={toggleClassName}>
                <input
                  checked={autoCompile}
                  className={checkboxClassName}
                  onChange={(event) => setAutoCompile((event.currentTarget as HTMLInputElement).checked)}
                  type="checkbox"
                />
                <span>Live</span>
              </label>

              <label className={toggleClassName}>
                <input
                  checked={rerun}
                  className={checkboxClassName}
                  onChange={(event) => setRerun((event.currentTarget as HTMLInputElement).checked)}
                  type="checkbox"
                />
                <span>Rerun</span>
              </label>

              <button className={commandButtonClassName} disabled={isBusy} onClick={runCompile} type="button">
                <Play aria-hidden="true" className={toolbarIconClassName} />
                <span>Compile</span>
              </button>
            </div>
          </div>
          <EditorPane
            handleRef={editorPaneRef}
            value={source}
            onChange={setSource}
            onCompile={runCompile}
            onScrollFrame={handleEditorScrollFrame}
          />
        </section>

        <section
          className={previewPaneClassName}
          aria-label="PDF preview"
        >
          {scrollOwner !== 'preview' ? (
            <SyncGateOverlay onActivate={() => setScrollOwner('preview')} />
          ) : null}
          <PdfPreview
            data={pdfData}
            handleRef={pdfPreviewRef}
            onScrollSyncSample={handlePdfScrollSyncSample}
            syncIndex={syncIndex}
          />
        </section>
      </main>

      <footer className={getLogPanelClassName(showLog)}>
        <button className={logToggleClassName} onClick={() => setShowLog((current) => !current)} type="button">
          <TerminalSquare aria-hidden="true" className={logToggleIconClassName} />
          <span>Log</span>
          <span className={getStatusPillClassName(state, true)}>
            {status.icon}
            {status.label}
          </span>
          {assetProgress !== null ? <span className="log-progress ml-auto">{Math.round(assetProgress)}%</span> : null}
        </button>
        {showLog ? <pre className={logPreClassName}>{log}</pre> : null}
      </footer>
    </div>
  );
}

function SyncGateOverlay({ onActivate }: { onActivate: () => void }) {
  return (
    <div
      aria-hidden="true"
      className={syncGateOverlayClassName}
      onPointerEnter={onActivate}
    />
  );
}

function getStatusPillClassName(state: CompileState, compact = false): string {
  const sizing = compact
    ? 'min-h-[26px] min-w-24 px-[9px] py-1'
    : 'min-w-[92px] px-[9px] py-[5px] min-[641px]:min-w-[110px]';
  const color =
    state === 'success'
      ? 'bg-emerald-100 text-emerald-700'
      : state === 'error'
        ? 'bg-red-100 text-red-700'
        : state === 'initializing' || state === 'compiling'
          ? 'bg-amber-100 text-amber-800'
          : 'bg-slate-200 text-slate-700';

  return `status-pill ${state} inline-flex items-center justify-center gap-1.5 rounded-full ${sizing} ${color}`;
}

function getLogPanelClassName(showLog: boolean): string {
  const state = showLog ? 'open grid grid-rows-[auto_minmax(72px,150px)]' : 'closed';
  return `log-panel ${state} border-t border-slate-300 bg-white`;
}

function resolveScrollSyncCheckpoints(
  ownerTop: number,
  owner: ScrollOwner,
  checkpointLines: number[],
  editor: EditorPaneHandle | null,
  preview: PdfPreviewHandle | null
): ScrollSyncCheckpointPair | null {
  if (checkpointLines.length < 2 || !editor || !preview) return null;

  const checkpoints = checkpointLines
    .map((line) => resolveScrollSyncCheckpoint(line, editor, preview))
    .filter((checkpoint): checkpoint is ScrollSyncCheckpoint => checkpoint !== null)
    .sort((left, right) => getCheckpointTop(left, owner) - getCheckpointTop(right, owner));
  if (checkpoints.length < 2) return null;

  const upperInsertion = lowerBoundBy(checkpoints, ownerTop, (checkpoint) => getCheckpointTop(checkpoint, owner));
  let lowerIndex: number;
  let upperIndex: number;

  if (upperInsertion <= 0) {
    lowerIndex = 0;
    upperIndex = 1;
  } else if (upperInsertion >= checkpoints.length) {
    lowerIndex = checkpoints.length - 2;
    upperIndex = checkpoints.length - 1;
  } else {
    lowerIndex = upperInsertion - 1;
    upperIndex = upperInsertion;
  }

  return {
    lower: checkpoints[lowerIndex],
    upper: checkpoints[upperIndex]
  };
}

function resolveStructuralCheckpointLines(source: string, syncIndex: SyncTexIndex | null): number[] {
  if (!syncIndex?.lines.length) return [];

  const maxSyncedLine = syncIndex.lines[syncIndex.lines.length - 1];
  const lines: number[] = [];
  const seen = new Set<number>();
  const sourceLines = source.split(/\r?\n/);

  for (let index = 0; index < sourceLines.length; index += 1) {
    const lineNumber = index + 1;
    if (lineNumber > maxSyncedLine) break;

    const line = stripTexComment(sourceLines[index]);
    if (!STRUCTURAL_CHECKPOINT_COMMAND_RE.test(line)) continue;
    if (seen.has(lineNumber)) continue;

    seen.add(lineNumber);
    lines.push(lineNumber);
  }

  return lines;
}

function stripTexComment(line: string): string {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== '%') continue;

    let slashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) {
      slashCount += 1;
    }

    if (slashCount % 2 === 0) {
      return line.slice(0, index);
    }
  }

  return line;
}

function resolveScrollSyncCheckpoint(
  sourceLine: number,
  editor: EditorPaneHandle,
  preview: PdfPreviewHandle
): ScrollSyncCheckpoint | null {
  const editorTop = editor.resolveSourceLineScrollTop(sourceLine);
  const previewTarget = preview.resolveSourceLineTarget(sourceLine);
  if (editorTop === null || !previewTarget) return null;

  return {
    editorTop,
    previewTop: previewTarget.top,
    sourceLine
  };
}

function getCheckpointTop(checkpoint: ScrollSyncCheckpoint, owner: ScrollOwner): number {
  return owner === 'editor' ? checkpoint.editorTop : checkpoint.previewTop;
}

function lowerBoundBy<T>(values: T[], target: number, getValue: (value: T) => number): number {
  let low = 0;
  let high = values.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (getValue(values[mid]) < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function formatCompileLog(log: string, exitCode: number, elapsedSeconds: string): string {
  const summary = `Compiled successfully in ${elapsedSeconds}s. Exit code: ${exitCode}.`;
  return log.trim() ? `${summary}\n\n${log.trim()}` : summary;
}

async function readSyncTexIndex(data: Uint8Array | null): Promise<[SyncTexIndex | null, string]> {
  if (!data) return [null, '\n\nSyncTeX: no sync data was produced.'];

  try {
    const index = await parseSyncTexIndex(data);
    return index ? [index, ''] : [null, '\n\nSyncTeX: no positions were found for main.tex.'];
  } catch (error) {
    return [null, `\n\nSyncTeX: ${formatError(error)}`];
  }
}

function isPickerAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readStoredTexEngine(key: string, fallback: TexEngine): TexEngine {
  const value = localStorage.getItem(key);
  return value === 'pdflatex' || value === 'xelatex' || value === 'lualatex' ? value : fallback;
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  const value = localStorage.getItem(key);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

export default App;
