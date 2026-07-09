import { useEffect, useRef } from 'preact/hooks';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/base/browser/ui/codicons/codiconStyles.js';
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { configureLatexLanguage } from '../lib/monacoLatex';

const monacoGlobal = self as unknown as {
  MonacoEnvironment?: monaco.Environment;
};

monacoGlobal.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  }
};

interface EditorPaneProps {
  handleRef?: HandleRef<EditorPaneHandle>;
  value: string;
  onChange: (value: string) => void;
  onCompile: () => void;
  onScrollFrame?: (sample: EditorScrollSample) => void;
}

export interface EditorScrollSample {
  centerLine: number;
  scrollTop: number;
}

export interface EditorPaneHandle {
  revealSourceLine: (line: number) => void;
}

interface HandleRef<T> {
  current: T | null;
}

export function EditorPane({ handleRef, value, onChange, onCompile, onScrollFrame }: EditorPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const valueRef = useRef(value);

  useEffect(() => {
    if (!handleRef) return;

    const handle: EditorPaneHandle = {
      revealSourceLine(line: number) {
        const editor = editorRef.current;
        if (!editor || line < 1) return;

        const lineNumber = Math.min(Math.max(1, Math.round(line)), editor.getModel()?.getLineCount() ?? line);
        editor.revealLineInCenterIfOutsideViewport(
          lineNumber,
          monaco.editor.ScrollType.Immediate
        );
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
    valueRef.current = value;
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) {
      editor.setValue(value);
    }
  }, [value]);

  useEffect(() => {
    if (!hostRef.current) return;

    configureLatexLanguage(monaco);

    const editor = monaco.editor.create(hostRef.current, {
      value: valueRef.current,
      language: 'latex',
      theme: 'vs',
      automaticLayout: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 14,
      lineHeight: 22,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderWhitespace: 'selection',
      wordWrap: 'on',
      padding: { top: 14, bottom: 14 },
      tabSize: 2
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, onCompile);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () => {
      void editor.getAction('actions.find')?.run();
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyH, () => {
      void editor.getAction('editor.action.startFindReplaceAction')?.run();
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyF, () => {
      void editor.getAction('editor.action.startFindReplaceAction')?.run();
    });

    let scrollFrame = 0;
    let stableFrames = 0;
    let lastScrollTop = Number.NaN;
    let lastCenterLine = 0;
    const sampleScrollFrame = () => {
      scrollFrame = 0;
      const visibleRange = editor.getVisibleRanges()[0];
      if (!visibleRange) {
        stableFrames += 1;
        return;
      }

      const centerLine = Math.round(
        (visibleRange.startLineNumber + visibleRange.endLineNumber) / 2
      );
      const scrollTop = editor.getScrollTop();
      const changed = scrollTop !== lastScrollTop || centerLine !== lastCenterLine;

      if (changed) {
        lastScrollTop = scrollTop;
        lastCenterLine = centerLine;
        stableFrames = 0;
        onScrollFrame?.({ centerLine, scrollTop });
      } else {
        stableFrames += 1;
      }

      if (stableFrames < 3) {
        scrollFrame = window.requestAnimationFrame(sampleScrollFrame);
      }
    };
    const trackScrollFrames = () => {
      stableFrames = 0;
      if (!scrollFrame) {
        scrollFrame = window.requestAnimationFrame(sampleScrollFrame);
      }
    };

    const changeSubscription = editor.onDidChangeModelContent(() => {
      const nextValue = editor.getValue();
      valueRef.current = nextValue;
      onChange(nextValue);
    });
    const scrollSubscription = editor.onDidScrollChange((event) => {
      if (event.scrollTopChanged) {
        trackScrollFrames();
      }
    });

    editorRef.current = editor;
    trackScrollFrames();

    return () => {
      if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
      scrollSubscription.dispose();
      changeSubscription.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, [onChange, onCompile, onScrollFrame]);

  return <div className="editor-host" ref={hostRef} />;
}
