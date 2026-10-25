/**
 * Structural analysis of one shell command line.
 *
 * Policy: a destructive delete may appear only as the single, top-level
 * statement of a command. Sequencing, pipes, grouping, loops, script blocks and
 * dynamic evaluation are violations, because they hide the delete behind other
 * work or let one mistake cascade.
 *
 * Quoted literals are masked before analysis so paths and message text cannot
 * create rules, while unquoted structure is preserved.
 */

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

const DYNAMIC_EVAL = /(invoke-expression|\biex\b|-encodedcommand|-command\b|cmd(?:\.exe)?\s+\/c|(?:bash|sh|pwsh|powershell)(?:\.exe)?\s+-c|start-process)/i;

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
    // A delete spelled inside a literal is still a delete when the literal is
    // evaluated by Invoke-Expression / -Command / cmd /c / shell -c.
    const rawHits = findDeletes(command, dialect);
    if (rawHits.length > 0) { verbs = rawHits; dynamicLiteral = true; }
  }
  if (verbs.length === 0) return result;
  result.isDelete = true;
  result.verbs = [...new Set(verbs)];

  for (const s of SEPARATORS) if (s.re.test(code)) result.issues.push({ code: s.code, message: s.message });
  for (const n of NESTING) if (n.re.test(code)) result.issues.push({ code: n.code, message: n.message });
  if (verbs.length > 1) result.issues.push({ code: 'multiple', message: 'contains ' + verbs.length + ' delete calls' });
  if (dynamicLiteral) result.issues.push({ code: 'dynamic-literal', message: 'delete is inside a literal that gets evaluated (Invoke-Expression / -Command / cmd /c / shell -c)' });
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
    'no -Command / cmd /c / bash -c / Start-Process / Invoke-Expression wrapping.',
  ];
  return lines.join('\n');
}
