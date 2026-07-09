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
  scrollRange: number;
  scrollTop: number;
}

export interface EditorScrollState {
  scrollRange: number;
  scrollTop: number;
}

export interface EditorPaneHandle {
  readScrollState: () => EditorScrollState | null;
  revealSourceLine: (line: number, options?: { force?: boolean }) => void;
  resolveSourceLineScrollTop: (line: number) => number | null;
  scrollToDisplacement: (displacement: number) => void;
  scrollToScrollTop: (top: number) => void;
  scrollToSourceLine: (line: number) => void;
}

interface HandleRef<T> {
  current: T | null;
}

const editorHostClassName = 'editor-host min-h-0 w-full';

export function EditorPane({ handleRef, value, onChange, onCompile, onScrollFrame }: EditorPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const valueRef = useRef(value);

  useEffect(() => {
    if (!handleRef) return;

    const handle: EditorPaneHandle = {
      readScrollState() {
        const editor = editorRef.current;
        if (!editor) return null;

        return {
          scrollRange: getEditorScrollRange(editor),
          scrollTop: editor.getScrollTop()
        };
      },
      revealSourceLine(line: number, options?: { force?: boolean }) {
        const editor = editorRef.current;
        if (!editor || line < 1) return;

        const lineNumber = Math.min(Math.max(1, Math.round(line)), editor.getModel()?.getLineCount() ?? line);
        if (options?.force) {
          editor.revealLineInCenter(lineNumber, monaco.editor.ScrollType.Immediate);
        } else {
          editor.revealLineInCenterIfOutsideViewport(
            lineNumber,
            monaco.editor.ScrollType.Immediate
          );
        }
      },
      resolveSourceLineScrollTop(line: number) {
        const editor = editorRef.current;
        if (!editor || line < 1) return null;

        return resolveSourceLineScrollTop(editor, line);
      },
      scrollToDisplacement(displacement: number) {
        const editor = editorRef.current;
        if (!editor) return;

        const target = clamp(displacement, 0, 1) * getEditorScrollRange(editor);
        editor.setScrollTop(target, monaco.editor.ScrollType.Immediate);
      },
      scrollToScrollTop(top: number) {
        const editor = editorRef.current;
        if (!editor) return;

        editor.setScrollTop(clamp(top, 0, getEditorScrollRange(editor)), monaco.editor.ScrollType.Immediate);
      },
      scrollToSourceLine(line: number) {
        const editor = editorRef.current;
        if (!editor || line < 1) return;

        const target = resolveSourceLineScrollTop(editor, line);
        if (target === null) return;

        editor.setScrollTop(target, monaco.editor.ScrollType.Immediate);
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

    let lastScrollTop = Number.NaN;
    let lastCenterLine = 0;
    const emitScrollSample = () => {
      const visibleRange = editor.getVisibleRanges()[0];
      if (!visibleRange) return;

      const centerLine = Math.round(
        (visibleRange.startLineNumber + visibleRange.endLineNumber) / 2
      );
      const scrollTop = editor.getScrollTop();
      const scrollRange = getEditorScrollRange(editor);
      const changed = scrollTop !== lastScrollTop || centerLine !== lastCenterLine;

      if (changed) {
        lastScrollTop = scrollTop;
        lastCenterLine = centerLine;
        onScrollFrame?.({ centerLine, scrollRange, scrollTop });
      }
    };

    const changeSubscription = editor.onDidChangeModelContent(() => {
      const nextValue = editor.getValue();
      valueRef.current = nextValue;
      onChange(nextValue);
    });
    const scrollSubscription = editor.onDidScrollChange((event) => {
      if (event.scrollTopChanged) {
        emitScrollSample();
      }
    });

    editorRef.current = editor;
    emitScrollSample();

    return () => {
      scrollSubscription.dispose();
      changeSubscription.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, [onChange, onCompile, onScrollFrame]);

  return <div className={editorHostClassName} ref={hostRef} />;
}

function resolveSourceLineScrollTop(
  editor: monaco.editor.IStandaloneCodeEditor,
  sourceLine: number
): number | null {
  const model = editor.getModel();
  if (!model) return null;

  const lineCount = model.getLineCount();
  const clampedLine = Math.min(Math.max(1, sourceLine), lineCount);
  const lineNumber = Math.floor(clampedLine);
  const nextLineNumber = Math.min(lineNumber + 1, lineCount);
  const lineTop = editor.getTopForLineNumber(lineNumber);
  const nextLineTop = nextLineNumber === lineNumber
    ? lineTop + editor.getOption(monaco.editor.EditorOption.lineHeight)
    : editor.getTopForLineNumber(nextLineNumber);
  const lineFraction = clampedLine - lineNumber;
  const interpolatedLineTop = lineTop + (nextLineTop - lineTop) * lineFraction;
  const layoutHeight = editor.getLayoutInfo().height;
  const maxScrollTop = getEditorScrollRange(editor);
  const target = interpolatedLineTop - layoutHeight * 0.46;

  return Math.min(Math.max(target, 0), maxScrollTop);
}

function getEditorScrollRange(editor: monaco.editor.IStandaloneCodeEditor): number {
  return Math.max(0, editor.getScrollHeight() - editor.getLayoutInfo().height);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
