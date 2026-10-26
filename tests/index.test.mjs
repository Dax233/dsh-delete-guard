import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, inject, name } from '../index.js';

const allowResult = { kind: 'allow' };

/** Install the plugin on a fake cordis context and return the hook. */
function install(config) {
  const handlers = [];
  const ctx = { on: (event, handler) => { handlers.push({ event, handler }); } };
  apply(ctx, config);
  return handlers;
}

const hook = () => {
  const handlers = install();
  assert.equal(handlers.length, 1);
  assert.equal(handlers[0].event, 'tools/pre-execute');
  return handlers[0].handler;
};

const run = (handler, exec, next) => handler(exec, next || (() => allowResult));

test('plugin keeps its loader contract', () => {
  assert.equal(name, 'delete-guard');
  assert.deepEqual(inject, ['tools']);
});

test('run_code with a filesystem delete is denied with an actionable reason', async () => {
  const result = await run(hook(), {
    name: 'run_code',
    arguments: { code: "fs.rmSync('dist', { recursive: true });" },
  });
  assert.equal(result.kind, 'deny');
  assert.match(result.reason, /run_code/);
  assert.match(result.reason, /standalone shell command/);
  assert.match(result.reason, /非删除逻辑/);
});

test('run_code without a delete passes through', async () => {
  const result = await run(hook(), {
    name: 'run_code',
    arguments: { code: "const data = fs.readFileSync('a.json', 'utf8'); console.log(data);" },
  });
  assert.deepEqual(result, allowResult);
});

test('allowRunCodeDeletes opens the explicit escape hatch', async () => {
  const handlers = install({ allowRunCodeDeletes: true });
  const result = await handlers[0].handler(
    { name: 'run_code', arguments: { code: "fs.rmSync('dist');" } },
    () => allowResult,
  );
  assert.deepEqual(result, allowResult);
});

test('codeTools overrides which code-bearing tools are covered', async () => {
  const handlers = install({ codeTools: ['run_python'] });
  const handler = handlers[0].handler;
  assert.deepEqual(
    await run(handler, { name: 'run_code', arguments: { code: "fs.rmSync('x');" } }),
    allowResult,
  );
  assert.equal(
    (await run(handler, { name: 'run_python', arguments: { code: "os.remove('x')" } })).kind,
    'deny',
  );
});

test('shell commands are still guarded', async () => {
  const handler = hook();
  assert.equal(
    (await run(handler, { name: 'pwsh', arguments: { command: "Remove-Item 'a'; Get-Date" } })).kind,
    'deny',
  );
  assert.deepEqual(
    await run(handler, {
      name: 'pwsh',
      arguments: { command: "Remove-Item -LiteralPath 'D:\\tmp\\a.txt' -Force" },
    }),
    allowResult,
  );
});

test('analysis exceptions fail open', async () => {
  const handler = hook();
  const exploding = {
    name: 'run_code',
    get arguments() { throw new Error('event contract changed'); },
  };
  assert.deepEqual(await run(handler, exploding), allowResult);
});

test('missing next() still falls back to allow', async () => {
  const handler = hook();
  const result = await handler({ name: 'run_code', arguments: { code: 'const a = 1;' } });
  assert.deepEqual(result, allowResult);
});

test('disabled config installs no hook', () => {
  assert.equal(install({ enabled: false }).length, 0);
});
