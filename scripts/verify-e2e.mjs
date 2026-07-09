import { chromium } from 'playwright-core';

const url = process.env.TEXMIRROR_URL ?? 'http://127.0.0.1:5173/';
const executablePath =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await chromium.launch({
  executablePath,
  headless: true
});

const page = await browser.newPage({
  viewport: { width: 1440, height: 960 }
});

const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') {
    consoleErrors.push(message.text());
  }
});

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => {
      const status = document.querySelector('.status-pill.success');
      const frame = document.querySelector('iframe.pdf-frame');
      const pdfHeader = document.querySelector('.preview-pane > .pane-header');
      const frameSrc = frame?.getAttribute('src') ?? '';
      const fileButtons = document.querySelectorAll('.file-actions button');
      const logClosed = document.querySelector('.log-panel.closed') && !document.querySelector('.log-panel pre');
      const engineSelect = document.querySelector('select[aria-label="LaTeX engine"]');
      const hasMainTexLabel = document.body.textContent?.includes('main.tex');
      return Boolean(
        status &&
          frameSrc.includes('/pdfjs/web/viewer.html?file=') &&
          !pdfHeader &&
          fileButtons.length === 2 &&
          logClosed &&
          engineSelect &&
          !hasMainTexLabel
      );
    },
    { timeout: 240000 }
  );

  await page.waitForFunction(
    () => {
      const frame = document.querySelector('iframe.pdf-frame');
      const frameDocument = frame?.contentDocument;
      const canvas = frameDocument?.querySelector('.pdfViewer .page canvas');
      return Boolean(
        frameDocument?.querySelector('#toolbarContainer') &&
          frameDocument.querySelector('#downloadButton') &&
          canvas &&
          canvas.width > 0 &&
          canvas.height > 0
      );
    },
    { timeout: 240000 }
  );

  const result = await page.evaluate(() => {
    const frame = document.querySelector('iframe.pdf-frame');
    const frameDocument = frame?.contentDocument;
    const canvas = frameDocument?.querySelector('.pdfViewer .page canvas');
    return {
      status: document.querySelector('.status-pill')?.textContent?.trim() ?? '',
      hasPdfHeader: Boolean(document.querySelector('.preview-pane > .pane-header')),
      logClosed: Boolean(document.querySelector('.log-panel.closed')),
      hasLogPre: Boolean(document.querySelector('.log-panel pre')),
      fileButtons: [...document.querySelectorAll('.file-actions button')].map((button) =>
        button.getAttribute('aria-label')
      ),
      engineSelect: document.querySelector('select[aria-label="LaTeX engine"]')?.value ?? '',
      hasMainTexLabel: Boolean(document.body.textContent?.includes('main.tex')),
      frameSrc: frame?.getAttribute('src')?.slice(0, 72) ?? '',
      frameTitle: frame?.getAttribute('title') ?? '',
      viewerTitle: frameDocument?.title ?? '',
      hasToolbar: Boolean(frameDocument?.querySelector('#toolbarContainer')),
      hasDownload: Boolean(frameDocument?.querySelector('#downloadButton')),
      pages: frameDocument?.querySelectorAll('.pdfViewer .page').length ?? 0,
      firstPage: canvas
        ? {
            width: canvas.width,
            height: canvas.height
          }
        : null,
      logLead: document.querySelector('.log-panel pre')?.textContent?.slice(0, 180) ?? ''
    };
  });

  console.log(JSON.stringify(result, null, 2));

  if (consoleErrors.length > 0) {
    console.warn('Console errors observed:');
    for (const error of consoleErrors) console.warn(error);
  }
} finally {
  await browser.close();
}
