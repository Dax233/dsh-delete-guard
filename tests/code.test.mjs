import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRunCode, findCodeDeletes } from '../lib/code.js';

const analyze = (code) => analyzeRunCode(code);

test('read, compute and write code passes', () => {
  const readWrite = [
    "import fs from 'node:fs';",
    "const raw = fs.readFileSync('data.json', 'utf8');",
    "const ids = JSON.parse(raw).map((row) => row.id);",
    "fs.writeFileSync('ids.txt', ids.join('\\n'));",
  ].join('\n');
  assert.equal(analyze(readWrite).isDelete, false);

  const compute = 'const sorted = [3, 1, 2].sort((a, b) => a - b); console.log(sorted.reduce((a, b) => a + b, 0));';
  assert.equal(analyze(compute).isDelete, false);

  const fspRead = "const fsp = require('node:fs/promises');\nconst body = await fsp.readFile(src, 'utf8');\nawait fsp.writeFile(out, body);";
  assert.equal(analyze(fspRead).isDelete, false);
});

test('delete API names in comments are not findings', () => {
  assert.equal(analyze("// fs.rmSync('x') would delete\nconst a = 1;").isDelete, false);
  assert.equal(analyze("/* shutil.rmtree(p), os.remove(p) */\nconst b = 2;").isDelete, false);
  assert.equal(analyze("value = 1  # os.remove(p) is how you would delete it\n").isDelete, false);
});

test('delete API names in plain strings are not findings', () => {
  assert.equal(analyze("const help = 'call fs.rmSync(p) to delete a tree';").isDelete, false);
  assert.equal(analyze('const note = "os.remove(p) / rimraf(dist)";').isDelete, false);
  assert.equal(analyze("fs.writeFileSync(out, 'shutil.rmtree(p)');").isDelete, false);
});

test('template literal interpolation is analyzed as code', () => {
  const result = analyze('const message = `tree: ${fs.rmSync(treePath)}`;');
  assert.equal(result.isDelete, true);
  assert.ok(result.issues.length > 0);
});

test('JavaScript/TypeScript filesystem delete calls are rejected', () => {
  const cases = [
    "fs.rmSync('dist', { recursive: true })",
    'fs.unlinkSync(entry)',
    'fs.rmdirSync(dir)',
    'await fs.promises.rm(path)',
    "const fsp = require('node:fs/promises'); await fsp.unlink(entry);",
    "fs['rmSync'](target)",
    'const { rm } = fs; rm(target)',
    "rimraf('dist')",
    "rimrafSync('dist')",
  ];
  for (const code of cases) {
    const result = analyze(code);
    assert.equal(result.isDelete, true, 'expected a delete finding: ' + code);
    assert.ok(result.verbs.length > 0, 'expected verbs: ' + code);
    assert.ok(result.issues.length > 0, 'expected issues: ' + code);
  }
});

test('Python filesystem delete calls are rejected', () => {
  const cases = [
    "import shutil\nshutil.rmtree('build')",
    'import os\nos.remove(path)',
    'os.unlink(path)',
    'os.rmdir(directory)',
    'from pathlib import Path\nPath(path).unlink()',
    'Path(path).rmdir()',
  ];
  for (const code of cases) {
    assert.equal(analyze(code).isDelete, true, 'expected a delete finding: ' + code);
  }
});

test('subprocess calls whose argument deletes are rejected', () => {
  const cases = [
    "const { execSync } = require('node:child_process');\nexecSync('rm -rf /tmp/x');",
    "require('child_process').spawnSync('rm', ['-rf', '/tmp/x']);",
    "const { exec } = require('node:child_process');\nexec('Remove-Item -Recurse C:\\\\tmp');",
    "import subprocess\nsubprocess.run(['rm', '-rf', '/tmp/x'])",
    'child_process.execSync(`rm -rf ${target}`)',
  ];
  for (const code of cases) {
    const result = analyze(code);
    assert.equal(result.isDelete, true, 'expected a delete finding: ' + code);
    assert.ok(
      result.issues.some((issue) => issue.code === 'subprocess-escape'),
      'expected a subprocess-escape issue: ' + code,
    );
  }
});

test('subprocess calls without a delete verb pass', () => {
  assert.equal(analyze("const { execSync } = require('child_process');\nexecSync('npm run build');").isDelete, false);
  assert.equal(analyze("require('child_process').spawn('node', ['server.js']);").isDelete, false);
  assert.equal(analyze("import subprocess\nsubprocess.run(['ls', '-la'])").isDelete, false);
});

test('shell delete text in ordinary strings is not a finding', () => {
  assert.equal(analyze("const note = 'rm -rf /tmp is dangerous'; console.log(note);").isDelete, false);
});

test('findCodeDeletes reports known delete APIs only', () => {
  assert.deepEqual(findCodeDeletes("fs.rmSync('x')"), ['fs.rmSync']);
  assert.ok(findCodeDeletes("shutil.rmtree('x')").includes('shutil.rmtree'));
  assert.deepEqual(findCodeDeletes("fs.writeFileSync('x', 'y')"), []);
  assert.deepEqual(findCodeDeletes('const a = 1;'), []);
});
