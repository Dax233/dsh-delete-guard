/**
 * Structural analysis of one shell command line.
 *
 * Policy: a destructive delete may appear only as the single, top-level
 * statement of a command. Sequencing, pipes, grouping, loops, script blocks and
 * dynamic evaluation are violations, because they hide the delete behind other
 * work or let one mistake cascade.
 *
 * Quoted literals are masked before analysis so paths and message text cannot
 * create rules, while unquoted structure is preserved. If a wrapper evaluates a
 * literal (`iex`, `-Command`, `cmd /c`, shell `-c`), or if an interpreter
 * evaluates code (`node -e`, `python -c`, ...), the literal is re-checked for
 * deletes: a delete spelled inside evaluated text is still a delete.
 */

import { analyzeRunCode } from './code.js';

const DELETE_PATTERNS = {
  pwsh: [
    { re: /\bremove-item\b/i, name: 'Remove-Item' },
    { re: /\bremove-itemproperty\b/i, name: 'Remove-ItemProperty' },
    { re: /\bclear-recyclebin\b/i, name: 'Clear-RecycleBin' },
    { re: /\[(?:system\.)?io\.(?:file|directory)\]::delete/i, name: 'IO ::Delete' },
    // CLI flags such as `docker run --rm` are not the alias: it counts only as
    // a bare command word, never attached to a dash.
    { re: /(?<![\w-])(ri|rm|del|erase|rd|rmdir)(?![\w-])/i, name: 'Remove-Item alias' },
  ],
  bash: [
    { re: /(?<![\w-])rm(?![\w-])/, name: 'rm' },
    { re: /(?<![\w-])rmdir(?![\w-])/, name: 'rmdir' },
    { re: /(?<![\w-])unlink(?![\w-])/, name: 'unlink' },
    { re: /(?<![\w-])shred(?![\w-])/, name: 'shred' },
    { re: /\bfind\b[^\n]*\s-delete\b/, name: 'find -delete' },
  ],
  cmd: [
    { re: /\b(del|erase|rd|rmdir)\b/i, name: 'del/rd' },
  ],
};

/**
 * Interpreted-language wrappers that evaluate a code literal. A delete call
 * inside the evaluated literal is a `dynamic-literal` violation.
 */
const INTERPRETER_WRAPPERS = [
  { re: /\bnode(?:\.exe)?(?:\s+-{1,2}[A-Za-z][\w-]*)*\s+(?:-e\b|--eval\b|-p\b|--print\b)/i, name: 'node -e/--eval/-p' },
  { re: /\bpython[0-9.]*(?:\.exe)?(?:\s+-[A-Za-z]+)*\s+-c\b/i, name: 'python -c' },
  { re: /\bperl(?:\.exe)?(?:\s+-[A-Za-z]+)*\s+-[eE]\b/i, name: 'perl -e/-E' },
  { re: /\bruby(?:\.exe)?(?:\s+-[A-Za-z]+)*\s+-e\b/i, name: 'ruby -e' },
  { re: /\bphp(?:\.exe)?(?:\s+-[A-Za-z]+)*\s+-r\b/i, name: 'php -r' },
  { re: /\bdeno(?:\s+-{1,2}[A-Za-z][\w-]*)*\s+eval\b/i, name: 'deno eval' },
  { re: /\bbun(?:\.exe)?(?:\s+-{1,2}[A-Za-z][\w-]*)*\s+(?:-e\b|--eval\b)/i, name: 'bun -e' },
];

const INTERPRETER_EVAL = new RegExp(
  INTERPRETER_WRAPPERS.map((w) => '(?:' + w.re.source + ')').join('|'),
  'i',
);

const NESTING = [
  { re: /\{/, code: 'block', message: 'contains a script block or code block {}' },
  { re: /\(/, code: 'group', message: 'contains grouping/subexpression ()' },
  { re: /\$\(/, code: 'subexpr', message: 'contains subexpression $()' },
  { re: /@\(/, code: 'array', message: 'contains array subexpression @()' },
  { re: /\b(if|elseif|else|foreach|for|while|do|switch|try|catch|function|filter|trap)\b/i, code: 'keyword', message: 'contains a control-flow keyword' },
  { re: /-enc\b|-encodedcommand\b/i, code: 'encoded', message: 'contains -EncodedCommand' },
  { re: /\b(invoke-expression|iex)\b/i, code: 'dynamic', message: 'contains Invoke-Expression/iex' },
  { re: /\bstart-process\b/i, code: 'wrapper', message: 'contains Start-Process indirection' },
  { re: /\bcmd(?:\.exe)?\s+\/c\b/i, code: 'wrapper', message: 'contains cmd /c indirection' },
  { re: /\b(?:bash|sh|pwsh|powershell)(?:\.exe)?\s+-[cC]\b/, code: 'wrapper', message: 'contains shell -c indirection' },
  { re: /-command\b/i, code: 'wrapper', message: 'contains -Command indirection' },
  ...INTERPRETER_WRAPPERS.map((w) => ({
    re: w.re,
    code: 'wrapper',
    message: 'contains ' + w.name + ' evaluation indirection',
  })),
];

const SEPARATORS = [
  { re: /;/, code: 'semicolon', message: 'contains ; statement sequencing' },
  { re: /&&/, code: 'and', message: 'contains && sequencing' },
  { re: /\|\|/, code: 'or', message: 'contains || sequencing' },
  { re: /\|/, code: 'pipe', message: 'contains a pipe |' },
  { re: /[\r\n]/, code: 'newline', message: 'contains a newline (multiple statements)' },
  { re: /(^|\s)&(\s|$)/, code: 'call', message: 'contains the & call operator' },
];

/** Replace quoted literal contents with a placeholder, keeping structure. */
export function maskLiterals(src) {
  const BT = String.fromCharCode(96);
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'") {
      out += 'Q';
      i += 1;
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") { i += 2; continue; }
        if (src[i] === "'") { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      out += 'Q';
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === BT) { i += 2; continue; }
        if (src[i] === '"') { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function dialectsFor(dialect) {
  if (dialect === 'pwsh') return ['pwsh'];
  if (dialect === 'bash') return ['bash'];
  if (dialect === 'cmd') return ['cmd'];
  return ['pwsh', 'bash'];
}

/** Shell-level evaluation: a literal gets handed to another shell. */
const SHELL_DYNAMIC_EVAL = /(invoke-expression|\biex\b|-encodedcommand|-command\b|cmd(?:\.exe)?\s+\/c|(?:bash|sh|pwsh|powershell)(?:\.exe)?\s+-c|start-process)/i;

/**
 * Any wrapper that evaluates a literal: shell-level evaluation, or an
 * interpreter (`node -e` / `python -c` / ...) evaluating code.
 */
const DYNAMIC_EVAL = new RegExp(
  '(?:' + SHELL_DYNAMIC_EVAL.source + ')|(?:' + INTERPRETER_EVAL.source + ')',
  'i',
);

const BACKTICK = String.fromCharCode(96);

function findDeletes(code, dialect) {
  const hits = [];
  for (const d of dialectsFor(dialect)) {
    for (const p of DELETE_PATTERNS[d]) {
      const rx = new RegExp(p.re.source, p.re.flags + 'g');
      const m = code.match(rx);
      if (m) for (let k = 0; k < m.length; k += 1) hits.push(p.name);
    }
  }
  return hits;
}

/**
 * Extract the literal that follows a wrapper match (`node -e "...."`).
 * @param {string} text raw command text
 * @param {number} from index right after the wrapper match
 * @returns {string} literal contents, or '' if the argument is not quoted
 */
function extractQuotedLiteral(text, from) {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  const quote = text[i];
  if (quote !== '"' && quote !== "'" && quote !== BACKTICK) return '';
  const start = i + 1;
  i = start;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === quote) return text.slice(start, i);
    i += 1;
  }
  return text.slice(start);
}

/**
 * Find deletes hidden in code literals evaluated by `node -e`, `python -c`, ...
 * Each wrapper is matched against the raw command text and the following
 * literal is analyzed as code.
 * @param {string} command raw command text
 * @returns {string[]} verb descriptions
 */
function findEvaluatedCodeDeletes(command) {
  const hits = [];
  for (const wrapper of INTERPRETER_WRAPPERS) {
    const flags = wrapper.re.flags.includes('g') ? wrapper.re.flags : wrapper.re.flags + 'g';
    const rx = new RegExp(wrapper.re.source, flags);
    let m;
    while ((m = rx.exec(command)) !== null) {
      const literal = extractQuotedLiteral(command, m.index + m[0].length);
      if (literal) {
        const code = analyzeRunCode(literal);
        if (code.isDelete) for (const verb of code.verbs) hits.push(wrapper.name + ': ' + verb);
      }
      if (m[0].length === 0) rx.lastIndex += 1;
    }
  }
  return hits;
}

/**
 * `[IO.File]::Delete('x')` needs parentheses for the call itself; those are
 * call syntax, not shell grouping. Strip balanced single-level call parens so a
 * single top-level .NET delete is allowed, while a nested expression inside the
 * call still trips the grouping rule.
 */
function stripDotNetDeleteCalls(code) {
  return code.replace(/::delete\s*\([^()]*\)/gi, '::delete ');
}

/**
 * Analyze one command string.
 * @param {string} command raw command text
 * @param {'pwsh'|'bash'|'cmd'|'auto'} dialect shell dialect
 */
export function analyzeCommand(command, dialect = 'auto') {
  const result = { isDelete: false, verbs: [], issues: [] };
  if (typeof command !== 'string' || command.trim().length === 0) return result;

  const code = maskLiterals(command);
  let verbs = findDeletes(code, dialect);
  let dynamicLiteral = false;
  if (verbs.length === 0 && DYNAMIC_EVAL.test(code)) {
    if (SHELL_DYNAMIC_EVAL.test(code)) {
      // A delete spelled inside a literal is still a delete when the literal is
      // evaluated by Invoke-Expression / -Command / cmd /c / shell -c.
      let rawHits = findDeletes(command, dialect);
      if (rawHits.length === 0) rawHits = findEvaluatedCodeDeletes(command);
      if (rawHits.length > 0) { verbs = rawHits; dynamicLiteral = true; }
    } else {
      // node -e / python -c / perl -e / ruby -e / php -r / deno eval / bun -e
      // evaluate the following literal as code.
      const codeHits = findEvaluatedCodeDeletes(command);
      if (codeHits.length > 0) { verbs = codeHits; dynamicLiteral = true; }
    }
  }
  if (verbs.length === 0) return result;
  result.isDelete = true;
  result.verbs = [...new Set(verbs)];

  const dotNetDeleteOnly = result.verbs.every((verb) => verb === 'IO ::Delete');
  const structure = dotNetDeleteOnly ? stripDotNetDeleteCalls(code) : code;

  for (const s of SEPARATORS) if (s.re.test(code)) result.issues.push({ code: s.code, message: s.message });
  for (const n of NESTING) if (n.re.test(structure)) result.issues.push({ code: n.code, message: n.message });
  if (verbs.length > 1) result.issues.push({ code: 'multiple', message: 'contains ' + verbs.length + ' delete calls' });
  if (dynamicLiteral) result.issues.push({ code: 'dynamic-literal', message: 'delete is inside a literal that gets evaluated (Invoke-Expression / -Command / shell -c / node -e / python -c / perl / ruby / php / deno / bun)' });
  return result;
}

/** Render a human/model-facing denial reason. */
export function formatDenial(analysis, command) {
  const snippet = command.length > 300 ? command.slice(0, 300) + '...' : command;
  const lines = [
    '[delete-guard] Rejected: a delete command must be executed on its own.',
    'Violations:',
    ...analysis.issues.map((i) => '  - ' + i.message),
    'Detected: ' + analysis.verbs.join(', '),
    'Command: ' + snippet,
    'Fix: run exactly one delete statement, nothing else in that command —',
    'no ; && || | or newline chaining, no if/foreach/for/$()/script block,',
    'no -Command / cmd /c / bash -c / Start-Process / Invoke-Expression wrapping,',
    'and no node -e / python -c / perl -e / ruby -e / php -r / deno eval evaluation.',
  ];
  return lines.join('\n');
}
