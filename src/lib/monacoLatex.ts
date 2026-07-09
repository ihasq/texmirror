import type * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';

let configured = false;

export function configureLatexLanguage(monacoApi: typeof monaco): void {
  if (configured) return;
  configured = true;

  if (!monacoApi.languages.getLanguages().some((language) => language.id === 'latex')) {
    monacoApi.languages.register({ id: 'latex', extensions: ['.tex', '.latex'] });
  }

  monacoApi.languages.setMonarchTokensProvider('latex', {
    defaultToken: '',
    tokenPostfix: '.tex',
    brackets: [
      { open: '{', close: '}', token: 'delimiter.curly' },
      { open: '[', close: ']', token: 'delimiter.square' },
      { open: '(', close: ')', token: 'delimiter.parenthesis' }
    ],
    tokenizer: {
      root: [
        [/%.*$/, 'comment'],
        [/\\(?:documentclass|usepackage|begin|end|section|subsection|subsubsection|paragraph|title|author|date|maketitle|label|ref|cite|bibliography|bibliographystyle|input|include)\b/, 'keyword'],
        [/\\(?:frac|sqrt|sum|prod|int|lim|left|right|mathrm|mathbf|mathit|textbf|emph|textit|texttt)\b/, 'type.identifier'],
        [/\\[a-zA-Z@]+|\\./, 'identifier'],
        [/\$[^$]*\$/, 'string'],
        [/[{}[\]()]/, '@brackets'],
        [/[0-9]+(?:\.[0-9]+)?/, 'number']
      ]
    }
  });

  monacoApi.languages.setLanguageConfiguration('latex', {
    comments: {
      lineComment: '%'
    },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')']
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '$', close: '$', notIn: ['string', 'comment'] }
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '$', close: '$' }
    ]
  });
}
