/**
 * dsh-delete-guard — keep destructive deletes standalone.
 *
 * Hooks the tool pipeline before dispatch and rejects any shell command in
 * which a delete verb is sequenced, piped, grouped, looped, wrapped or driven
 * dynamically. A single top-level delete statement is allowed through; the
 * sandbox and approval layers still apply to it.
 *
 * Rationale: a recursive delete that rides along with other statements is the
 * shape that turns one bad variable into a wiped home directory. Requiring the
 * delete to be its own command makes the target reviewable in isolation.
 *
 * @module @local/dsh-delete-guard
 */
import { analyzeCommand, formatDenial } from './lib/detect.js';

/** Loader row name. */
export const name = 'delete-guard';

/** The tool registry must exist before the hook can be installed. */
export const inject = ['tools'];

/** Command-bearing argument per tool. */
const ARGUMENT = {
  pwsh: 'command',
  bash: 'command',
  shell: 'command',
  cmd: 'command',
  terminal_send: 'text',
};

/** Shell dialect per tool; terminal text is analyzed as both dialects. */
const DIALECT = {
  pwsh: 'pwsh',
  bash: 'bash',
  shell: 'bash',
  cmd: 'cmd',
  terminal_send: 'auto',
};

const DEFAULT_TOOLS = ['pwsh', 'bash', 'shell', 'cmd', 'terminal_send'];

/**
 * Install the pre-execute gate.
 * @param ctx cordis context with the tools service
 * @param config plugin configuration
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return;
  const guarded = new Set(
    Array.isArray(config.tools) && config.tools.length > 0 ? config.tools : DEFAULT_TOOLS,
  );

  ctx.on('tools/pre-execute', async (exec, next) => {
    // Fail open if the event contract ever changes: a guard bug must not wedge
    // every tool call in the session.
    const proceed = typeof next === 'function' ? next : () => ({ kind: 'allow' });
    try {
      const toolName = exec && exec.name;
      if (!guarded.has(toolName)) return proceed();
      const argName = ARGUMENT[toolName] || 'command';
      const args = (exec && exec.arguments) || {};
      const text = args[argName];
      const analysis = analyzeCommand(text, DIALECT[toolName] || 'auto');
      if (!analysis.isDelete || analysis.issues.length === 0) return proceed();
      return { kind: 'deny', reason: formatDenial(analysis, String(text)) };
    } catch {
      return proceed();
    }
  });
}
