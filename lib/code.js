/**
 * Static analysis of evaluated *code* text: the `run_code` tool argument, and
 * code hidden inside interpreter-evaluated literals (`node -e`,
 * `python -c`, ...).
 *
 * Policy: a filesystem delete must never be hidden inside a program. The only
 * supported channel is a single, top-level shell delete statement, which
 * `lib/detect.js` can review as one command. Consequently any recognizable
 * delete API call in code is a finding: the fix is to lift the delete into its
 * own shell command and keep the rest of the work in code.
 *
 * The analysis is heuristic. Comments and string literals are masked before
 * matching, so API names in docs or in innocent data strings do not create
 * findings, while template-literal interpolation — which *is* evaluated — stays
 * visible. Verb names are informational; any hit is a violation.
 *
 * All exported functions are pure: no I/O, no state, no dependencies beyond the
 * JavaScript language itself.
 */

const BACKTICK = String.fromCharCode(96);

/** Filesystem delete API calls, by ecosystem. Matched against masked code. */
const DELETE_CALLS = [
  // JavaScript / TypeScript.
  { name: 'fs.rmSync', re: /\brmSync\s*\(/ },
  { name: 'fs.unlinkSync', re: /\bunlinkSync\s*\(/ },
  { name: 'fs.rmdirSync', re: /\brmdirSync\s*\(/ },
  { name: 'rimraf', re: /(?<![\w$])rimraf(?:Sync)?\s*\(/ },
  { name: 'rmtree', re: /\brmtree\s*\(/ },
  {
    name: 'fs delete call',
    re: /(?<![\w$])(?:fs|fsp|fsPromises|fsExtra|fse|promises)\s*\.\s*(?:rm|unlink|rmdir|remove|removeSync|emptyDir)\s*\(/,
  },
  // Receiver-agnostic method form: `fsp.rm()`, `fs.promises.rm()`,
  // `Path('x').unlink()`, `dir.rmdir()`. Deliberately conservative.
  { name: 'file delete method', re: /\.\s*(?:rm|unlink|rmdir)\s*\(/ },
  // Bare call after destructuring: `const { rm } = fs; rm(p)`.
  { name: 'delete call', re: /(?<![\w$.])(?<!function\s)(?:rm|unlink|rmdir)\s*\(/ },
  // Python.
  { name: 'shutil.rmtree', re: /\bshutil\s*\.\s*rmtree\s*\(/ },
  { name: 'os.remove', re: /\bos\s*\.\s*(?:remove|unlink|rmdir|removedirs)\s*\(/ },
  // Ruby / Deno, reachable through interpreter wrappers.
  { name: 'FileUtils.rm_rf', re: /\bFileUtils\s*\.\s*rm_rf\s*\(/ },
  { name: 'File.delete', re: /\bFile\s*\.\s*(?:delete|unlink)\s*\(/ },
  { name: 'Deno.remove', re: /\bDeno\s*\.\s*(?:remove|removeSync|removeAllSync)\s*\(/ },
];

/** Computed property access to a delete API: `fs['rmSync'](...)`. */
const COMPUTED_DELETE = /\[\s*(['"])(?:rm|unlink|rmdir|remove|removeSync|emptyDir|unlinkSync|rmSync|rmdirSync)\1\s*\]\s*\(/;

/** Code that can run a subprocess; delete commands sometimes hide there. */
const CHILD_PROCESS = /(?:child_process|childProcess|execSync|execFileSync|spawnSync|(?<![\w$.])(?:exec|execFile|spawn)\s*\(|subprocess\s*\.|os\s*\.\s*(?:system|popen)\s*\()/;

/** Shell delete verbs, searched only inside string literals that reach a subprocess. */
const SHELL_DELETE = /(?<![\w-])(?:rm|rmdir|unlink|shred|del|erase|rd)(?![\w-])|remove-item(?:property)?|clear-recyclebin|\[(?:system\.)?io\.(?:file|directory)\]::delete|find\b[^\n]*\s-delete\b/i;

/**
 * Mask comments and string/template literals in a code snippet, preserving the
 * surrounding structure (operators, parentheses, identifiers).
 *
 * Template interpolation `${...}` is evaluated code, so it is scanned as code
 * and left visible.
 *
 * @param {string} src source text
 * @param {{ keepStrings?: boolean, strings?: string[] }} [options]
 *   keepStrings: emit literal contents instead of masking them;
 *   strings: collect literal contents for out-of-band inspection.
 * @returns {string} masked text
 */
function scan(src, options = {}) {
  const keepStrings = options.keepStrings === true;
  const strings = Array.isArray(options.strings) ? options.strings : null;
  const text = String(src);
  const n = text.length;
  const out = [];
  let i = 0;

  function emitMaskedNewlines(start, end) {
    for (let k = start; k < end; k += 1) if (text[k] === '\n') out.push('\n');
  }

  function scanQuoted(quote) {
    const start = i;
    let close = n;
    while (i < n) {
      const ch = text[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) { close = i; i += 1; break; }
      i += 1;
    }
    const end = Math.min(close, n);
    const content = text.slice(start, end);
    if (strings) strings.push(content);
    if (keepStrings) out.push(quote + content + quote);
    else emitMaskedNewlines(start, end);
  }

  function flushTemplateSegment(start, end) {
    if (end <= start) return;
    const content = text.slice(start, end);
    if (strings) strings.push(content);
    if (keepStrings) out.push(BACKTICK + content + BACKTICK);
    else emitMaskedNewlines(start, end);
  }

  function scanTemplate() {
    let segmentStart = i;
    while (i < n) {
      const ch = text[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === BACKTICK) {
        flushTemplateSegment(segmentStart, i);
        i += 1;
        return;
      }
      if (ch === '$' && text[i + 1] === '{') {
        flushTemplateSegment(segmentStart, i);
        i += 2;
        scanCode(true);
        segmentStart = i;
        continue;
      }
      i += 1;
    }
    flushTemplateSegment(segmentStart, Math.min(i, n));
  }

  function skipLine() {
    while (i < n && text[i] !== '\n') i += 1;
  }

  function skipBlockComment() {
    i += 2;
    while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
      if (text[i] === '\n') out.push('\n');
      i += 1;
    }
    if (i < n) i += 2;
  }

  function scanCode(stopOnBrace) {
    let depth = 0;
    while (i < n) {
      const ch = text[i];
      const nx = text[i + 1];
      if (stopOnBrace) {
        if (ch === '{') { depth += 1; out.push(ch); i += 1; continue; }
        if (ch === '}') {
          if (depth === 0) { i += 1; return; }
          depth -= 1;
          out.push(ch);
          i += 1;
          continue;
        }
      }
      if (ch === '/' && nx === '/') { skipLine(); continue; }
      if (ch === '/' && nx === '*') { skipBlockComment(); continue; }
      if (ch === '#') {
        // Python-style comment. Require start-of-line/whitespace so JS private
        // fields (`this.#x`) are not swallowed.
        const prev = i === 0 ? '\n' : text[i - 1];
        if (/\s/.test(prev)) { skipLine(); continue; }
      }
      if (ch === "'" || ch === '"') { i += 1; scanQuoted(ch); continue; }
      if (ch === BACKTICK) { i += 1; scanTemplate(); continue; }
      out.push(ch);
      i += 1;
    }
  }

  scanCode(false);
  return out.join('');
}

/**
 * Mask comments and literals in a code snippet.
 * @param {string} code
 * @returns {string}
 */
export function maskCode(code) {
  return scan(code, {});
}

/**
 * Report names of filesystem delete API calls present in already-masked text.
 * @param {string} text
 * @returns {string[]}
 */
export function findCodeDeletes(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const names = [];
  for (const rule of DELETE_CALLS) if (rule.re.test(text)) names.push(rule.name);
  if (COMPUTED_DELETE.test(text)) names.push('computed delete access');
  return [...new Set(names)];
}

/**
 * Analyze code text for filesystem deletion.
 *
 * @param {string} code source text (JavaScript/TypeScript or Python)
 * @returns {{isDelete: boolean, verbs: string[], issues: Array<{code: string, message: string}>}}
 */
export function analyzeRunCode(code) {
  const result = { isDelete: false, verbs: [], issues: [] };
  if (typeof code !== 'string' || code.trim().length === 0) return result;

  const strings = [];
  const masked = scan(code, {});
  // Strings are kept here only so computed access such as fs['rmSync'] stays
  // visible; direct API names elsewhere are matched on the masked text.
  const withStrings = scan(code, { keepStrings: true, strings });

  const verbs = findCodeDeletes(masked);
  if (COMPUTED_DELETE.test(withStrings)) verbs.push('computed delete access');

  const issues = [];
  const uniqueVerbs = [...new Set(verbs)];
  if (uniqueVerbs.length > 0) {
    issues.push({
      code: 'run-code-delete',
      message: 'run_code calls a filesystem delete API (' + uniqueVerbs.join(', ') + ')',
    });
  }

  const subprocess = CHILD_PROCESS.test(withStrings);
  if (subprocess) {
    const stringHits = [];
    for (const literal of strings) {
      if (SHELL_DELETE.test(literal)) stringHits.push('shell delete verb');
      for (const rule of DELETE_CALLS) {
        if (rule.re.test(literal)) { stringHits.push(rule.name); break; }
      }
    }
    if (stringHits.length > 0) {
      verbs.push('subprocess delete');
      issues.push({
        code: 'subprocess-escape',
        message: 'run_code runs a subprocess whose command text contains a delete (' +
          [...new Set(stringHits)].join(', ') + ')',
      });
    }
  }

  if (issues.length === 0) return result;
  result.isDelete = true;
  result.verbs = [...new Set(verbs)];
  result.issues = issues;
  return result;
}

/** Render a human/model-facing denial reason for `run_code`. */
export function formatRunCodeDenial(analysis, code) {
  const text = typeof code === 'string' ? code : '';
  const snippet = text.length > 300 ? text.slice(0, 300) + '...' : text;
  return [
    '[delete-guard] Rejected run_code: filesystem deletion must not be hidden inside code.',
    'Detected: ' + analysis.verbs.join(', '),
    'Violations:',
    ...analysis.issues.map((issue) => '  - ' + issue.message),
    'Code: ' + snippet,
    'Fix: run the delete as exactly one standalone shell command instead (delete-guard',
    "allows a single top-level delete, e.g. Remove-Item -LiteralPath 'D:\\tmp\\a.txt' -Force),",
    'and keep all non-delete logic in run_code.',
    '（run_code 里的文件删除会把删除藏在程序里；请改用独立的一条 shell 删除命令，',
    'delete-guard 会放行单条顶层删除；非删除逻辑照常写在 run_code。）',
  ].join('\n');
}
