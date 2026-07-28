# PDF.js viewer

This directory is a copied runtime distribution of PDF.js 6.2.108, taken from:

https://github.com/mozilla/pdf.js/releases/download/v6.2.108/pdfjs-6.2.108-dist.zip

It is intentionally vendored as static assets rather than included as a git
submodule. Source maps are omitted; runtime viewer assets, licenses, fonts,
CMaps, ICC profiles, and WASM helpers are included.
