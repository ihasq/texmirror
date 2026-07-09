export const DEFAULT_TEX = String.raw`\documentclass[11pt]{article}
\usepackage{amsmath}
\usepackage{geometry}
\geometry{margin=24mm}

\title{TeX Mirror}
\author{Browser TeX + Monaco + PDF.js}
\date{\today}

\begin{document}
\maketitle

\section{Live editing}
This document is compiled in the browser with a WebAssembly TeX engine.
Edit the source on the left and keep the rendered PDF visible on the right.

\[
  \int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
\]

\section{A small table}
\begin{center}
\begin{tabular}{lll}
Engine & Runtime & Output \\
\hline
pdfLaTeX & WebAssembly & PDF \\
XeLaTeX & WebAssembly & PDF \\
LuaLaTeX & WebAssembly & PDF \\
\end{tabular}
\end{center}

\end{document}
`;
