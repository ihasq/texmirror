import {
  BusyTexRunner,
  LuaLatex,
  PdfLatex,
  XeLatex,
  type CompileResult,
  type DownloadProgress
} from 'texlyre-busytex';
import { BUSYTEX_BASE_PATH, BUSYTEX_DATA_PACKAGES } from './paths';

export type TexEngine = 'pdflatex' | 'xelatex' | 'lualatex';

export interface CompileRequest {
  source: string;
  engine: TexEngine;
  rerun: boolean;
}

export interface CompileSuccess {
  pdf: Uint8Array;
  synctex: Uint8Array | null;
  log: string;
  exitCode: number;
}

type TexTool = PdfLatex | XeLatex | LuaLatex;

export class BrowserTexCompiler {
  private readonly runner: BusyTexRunner;
  private readonly tools = new Map<TexEngine, TexTool>();

  constructor(onDownloadProgress: (progress: DownloadProgress) => void) {
    this.runner = new BusyTexRunner({
      busytexBasePath: BUSYTEX_BASE_PATH,
      engineMode: 'combined',
      preloadDataPackages: [BUSYTEX_DATA_PACKAGES.extra],
      catalogDataPackages: [],
      onDownloadProgress,
      verbose: false
    });
  }

  async compile(request: CompileRequest): Promise<CompileResult> {
    if (!this.runner.isInitialized()) {
      await this.runner.initialize(true);
    }

    return this.getTool(request.engine).compile({
      input: request.source,
      mainTexPath: 'main.tex',
      verbose: 'info',
      rerun: request.rerun
    });
  }

  terminate(): void {
    this.runner.terminate();
  }

  private getTool(engine: TexEngine): TexTool {
    const existing = this.tools.get(engine);
    if (existing) return existing;

    const next =
      engine === 'pdflatex'
        ? new PdfLatex(this.runner)
        : engine === 'xelatex'
          ? new XeLatex(this.runner)
          : new LuaLatex(this.runner);

    this.tools.set(engine, next);
    return next;
  }
}

export function toCompileSuccess(result: CompileResult): CompileSuccess {
  if (!result.success || !result.pdf) {
    throw new Error(result.log || `TeX exited with code ${result.exitCode}`);
  }

  return {
    pdf: new Uint8Array(result.pdf),
    synctex: result.synctex ? new Uint8Array(result.synctex) : null,
    log: result.log,
    exitCode: result.exitCode
  };
}
