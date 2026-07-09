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
import { PdfPreview, type PdfPreviewHandle } from './components/PdfPreview';
import { DEFAULT_TEX } from './lib/examples';
import {
  BrowserTexCompiler,
  type CompileRequest,
  type TexEngine,
  toCompileSuccess
} from './lib/texCompiler';
import { parseSyncTexIndex, type SyncTexIndex } from './lib/synctex';

type CompileState = 'idle' | 'initializing' | 'compiling' | 'success' | 'error';
type ActivePane = 'editor' | 'preview';

const STORAGE_KEY = 'texmirror.source';
const ENGINE_STORAGE_KEY = 'texmirror.engine';
const RERUN_STORAGE_KEY = 'texmirror.rerun';
const AUTO_COMPILE_STORAGE_KEY = 'texmirror.autoCompile';
const DEBOUNCE_MS = 900;
const DEFAULT_SAVE_NAME = 'document.tex';
const TEX_FILE_TYPES: FilePickerAcceptType[] = [
  {
    description: 'TeX source',
    accept: {
      'text/plain': ['.tex', '.latex', '.ltx', '.txt']
    }
  }
];

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
  const [activePane, setActivePaneState] = useState<ActivePane>('editor');

  const compilerRef = useRef<BrowserTexCompiler | null>(null);
  const compilingRef = useRef(false);
  const queuedRef = useRef(false);
  const activePaneRef = useRef<ActivePane>('editor');
  const fileHandleRef = useRef<FileSystemFileHandle | null>(null);
  const editorPaneRef = useRef<EditorPaneHandle | null>(null);
  const pdfPreviewRef = useRef<PdfPreviewHandle | null>(null);
  const editorScrollSampleRef = useRef<EditorScrollSample>({ centerLine: 1, scrollTop: 0 });
  const sourceRef = useRef(source);
  const optionsRef = useRef({ engine, rerun });
  const canUseFileSystem = typeof window.showOpenFilePicker === 'function' &&
    typeof window.showSaveFilePicker === 'function';

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
    if (!syncIndex) return;

    let frame = 0;
    const timers: number[] = [];
    const scrollToCurrentEditorLine = () => {
      pdfPreviewRef.current?.scrollToSourceLine(editorScrollSampleRef.current.centerLine);
    };

    scrollToCurrentEditorLine();
    frame = window.requestAnimationFrame(scrollToCurrentEditorLine);
    timers.push(window.setTimeout(scrollToCurrentEditorLine, 180));
    timers.push(window.setTimeout(scrollToCurrentEditorLine, 500));

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      for (const timer of timers) window.clearTimeout(timer);
    };
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
    if (queued) return { label: 'Queued', icon: <LoaderCircle className="spin" /> };
    if (state === 'initializing') return { label: 'Initializing', icon: <LoaderCircle className="spin" /> };
    if (state === 'compiling') return { label: 'Compiling', icon: <LoaderCircle className="spin" /> };
    if (state === 'success') return { label: 'Ready', icon: <CheckCircle2 /> };
    if (state === 'error') return { label: 'Error', icon: <XCircle /> };
    return { label: 'Idle', icon: <FileText /> };
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

  const setActivePane = useCallback((pane: ActivePane) => {
    activePaneRef.current = pane;
    setActivePaneState((current) => current === pane ? current : pane);
  }, []);

  const handleEditorScrollFrame = useCallback((sample: EditorScrollSample) => {
    editorScrollSampleRef.current = sample;
    if (activePaneRef.current !== 'editor') return;

    pdfPreviewRef.current?.scrollToSourceLine(sample.centerLine);
  }, []);

  const handlePdfSourceLineRequest = useCallback((line: number) => {
    if (activePaneRef.current !== 'preview') return;

    editorPaneRef.current?.revealSourceLine(line);
  }, []);

  const getCurrentEditorSourceLine = useCallback(() => {
    return editorScrollSampleRef.current.centerLine;
  }, []);

  return (
    <div className="app-shell">
      <main className="workspace">
        <section
          className="pane editor-pane"
          aria-label="LaTeX source editor"
          onFocusCapture={() => setActivePane('editor')}
          onPointerDown={() => setActivePane('editor')}
          onPointerEnter={() => setActivePane('editor')}
        >
          <div className="pane-header editor-header">
            <div className="pane-title">
              <div className="file-actions" aria-label="File actions">
                <button
                  aria-label="Open TeX file"
                  className="tool-button"
                  disabled={!canUseFileSystem}
                  onClick={openTexFile}
                  title="Open TeX file"
                  type="button"
                >
                  <FolderOpen aria-hidden="true" />
                </button>
                <button
                  aria-label="Save TeX file"
                  className="tool-button"
                  disabled={!canUseFileSystem}
                  onClick={saveTexFile}
                  title="Save TeX file"
                  type="button"
                >
                  <Save aria-hidden="true" />
                </button>
              </div>
              {fileName ? <span className="file-name">{fileName}</span> : null}
            </div>

            <div className="toolbar editor-toolbar">
              <label className="select-control">
                <span>LaTeX</span>
                <select
                  aria-label="LaTeX engine"
                  onChange={(event) => setEngine((event.currentTarget as HTMLSelectElement).value as TexEngine)}
                  value={engine}
                >
                  <option value="pdflatex">pdfLaTeX</option>
                  <option value="xelatex">XeLaTeX</option>
                  <option value="lualatex">LuaLaTeX</option>
                </select>
              </label>

              <label className="toggle">
                <input
                  checked={autoCompile}
                  onChange={(event) => setAutoCompile((event.currentTarget as HTMLInputElement).checked)}
                  type="checkbox"
                />
                <span>Live</span>
              </label>

              <label className="toggle">
                <input
                  checked={rerun}
                  onChange={(event) => setRerun((event.currentTarget as HTMLInputElement).checked)}
                  type="checkbox"
                />
                <span>Rerun</span>
              </label>

              <button className="command-button" disabled={isBusy} onClick={runCompile} type="button">
                <Play aria-hidden="true" />
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
          className="pane preview-pane"
          aria-label="PDF preview"
          onPointerDown={() => setActivePane('preview')}
          onPointerEnter={() => setActivePane('preview')}
        >
          <PdfPreview
            data={pdfData}
            getCurrentSourceLine={getCurrentEditorSourceLine}
            handleRef={pdfPreviewRef}
            onSourceLineRequest={handlePdfSourceLineRequest}
            reverseSyncEnabled={activePane === 'preview'}
            syncIndex={syncIndex}
          />
        </section>
      </main>

      <footer className={`log-panel ${showLog ? 'open' : 'closed'}`}>
        <button className="log-toggle" onClick={() => setShowLog((current) => !current)} type="button">
          <TerminalSquare aria-hidden="true" />
          <span>Log</span>
          <span className={`status-pill ${state}`}>
            {status.icon}
            {status.label}
          </span>
          {assetProgress !== null ? <span className="log-progress">{Math.round(assetProgress)}%</span> : null}
        </button>
        {showLog ? <pre>{log}</pre> : null}
      </footer>
    </div>
  );
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
