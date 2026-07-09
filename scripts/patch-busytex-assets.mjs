import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const pipelinePath = resolve('public/core/busytex/busytex_pipeline.js');

let source = await readFile(pipelinePath, 'utf8');

const replacements = [
  [
    String.raw`this.regex_usepackage = /\\usepackage(\[.*?\])?\{(.+?)\}/g;`,
    String.raw`this.regex_usepackage = /\\(?:usepackage|RequirePackage)\s*(?:\[.*?\])?\s*\{(.+?)\}/g;`
  ],
  [
    "const tex_packages = files.filter(f => typeof (f.contents) == 'string' && f.path == main_tex_path).map(f => f.contents.split('\\n').filter(l => l.trim().startsWith('\\\\usepackage')).map(l => Array.from(l.matchAll(this.regex_usepackage)).filter(groups => groups.length >= 2).map(groups => groups.pop().split(',')))).flat().flat().flat();",
    "const tex_packages = files.filter(f => typeof (f.contents) == 'string' && f.path == main_tex_path).map(f => Array.from(f.contents.matchAll(this.regex_usepackage)).filter(groups => groups.length >= 2).map(groups => groups.pop().split(',').map(tex_package => tex_package.trim()).filter(tex_package => tex_package.length > 0))).flat().flat();"
  ],
  [
    "const effective_exit_code = stdout.trim() ? (error_messages.some(err => stdout.includes(err)) ? exit_code : 0) : exit_code;",
    "const effective_exit_code = exit_code !== 0 || error_messages.some(err => stdout.includes(err) || stderr.includes(err) || log.includes(err)) ? exit_code || 1 : 0;"
  ]
];

let patched = false;
for (const [before, after] of replacements) {
  if (source.includes(before)) {
    source = source.replace(before, after);
    patched = true;
  }
}

await writeFile(pipelinePath, source);
console.log(patched ? 'Patched BusyTeX assets.' : 'BusyTeX assets already patched.');
