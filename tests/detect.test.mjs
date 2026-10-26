import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCommand, maskLiterals } from '../lib/detect.js';

const deny = (cmd, dialect = 'pwsh') => {
  const r = analyzeCommand(cmd, dialect);
  return r.isDelete && r.issues.length > 0;
};
const allow = (cmd, dialect = 'pwsh') => {
  const r = analyzeCommand(cmd, dialect);
  return !r.isDelete || r.issues.length === 0;
};

test('single top-level deletes are allowed', () => {
  assert.ok(allow("Remove-Item -LiteralPath 'D:\\tmp\\a.txt' -Force"));
  assert.ok(allow("Remove-Item -LiteralPath 'D:\\tmp\\a' -Recurse -Force"));
  assert.ok(allow('rm -rf /tmp/foo'));
  assert.ok(allow('rmdir /s /q D:\\tmp\\x', 'cmd'));
});

test('sequencing is rejected', () => {
  assert.ok(deny("Remove-Item 'a'; Write-Host done"));
  assert.ok(deny("Remove-Item 'a' && echo ok"));
  assert.ok(deny("Remove-Item 'a' || echo fail"));
  assert.ok(deny('Remove-Item a\nGet-Date'));
  assert.ok(deny('echo x | Remove-Item a'));
});

test('nesting is rejected', () => {
  assert.ok(deny("if ($true) { Remove-Item 'a' }"));
  assert.ok(deny("foreach ($f in $files) { Remove-Item $f }"));
  assert.ok(deny('Remove-Item (Join-Path $d $f)'));
  assert.ok(deny('1..3 | ForEach-Object { Remove-Item $_ }'));
  assert.ok(deny("Remove-Item 'a' | Out-Null"));
});

test('indirection and dynamic evaluation are rejected', () => {
  assert.ok(deny('Invoke-Expression "Remove-Item a"'));
  assert.ok(deny('iex "Remove-Item a"'));
  assert.ok(deny('Start-Process pwsh -ArgumentList "Remove-Item a"'));
  assert.ok(deny('cmd /c del /q a'));
  assert.ok(deny('bash -c "rm -rf /tmp/x"'));
  assert.ok(deny('pwsh -Command "Remove-Item a"'));
});

test('multiple delete calls are rejected', () => {
  assert.ok(deny("Remove-Item 'a' Remove-Item 'b'"));
  assert.ok(deny('rm -rf /a /b && rm -rf /c'));
});

test('non-delete commands pass', () => {
  assert.ok(allow('Get-ChildItem C:\\'));
  assert.ok(allow('echo "Remove-Item is a cmdlet"'));
  assert.ok(allow("Write-Host 'rm -rf'"));
  assert.equal(analyzeCommand('Get-Process').isDelete, false);
});

test('quoted literals do not mask structure', () => {
  assert.equal(maskLiterals("Remove-Item 'a;b'").includes(';'), false);
  assert.ok(deny("Remove-Item 'a;b'; Get-Date"));
});

test('bash dialect detects bash verbs', () => {
  assert.ok(deny('rm -rf /tmp/x && echo done', 'bash'));
  assert.ok(allow('rm -rf /tmp/x', 'bash'));
  assert.ok(allow('find /tmp -name "*.log" -delete', 'bash'));
  assert.ok(deny('find /tmp -name "*.log" -delete && echo done', 'bash'));
});
test('CLI flags that look like delete aliases are not deletes', () => {
  assert.equal(analyzeCommand('docker run --rm redis:8-alpine env', 'pwsh').isDelete, false);
  assert.equal(analyzeCommand('docker run --rm -it alpine sh', 'pwsh').isDelete, false);
});
test('command subcommands that delete are allowed as single statements', () => {
  const a = analyzeCommand('docker rm -f headroom', 'pwsh');
  assert.equal(a.isDelete, true);
  assert.equal(a.issues.length, 0);
  assert.equal(analyzeCommand('git rm file.txt', 'pwsh').issues.length, 0);
});
test('interpreter wrappers that evaluate delete code are rejected', () => {
  assert.ok(deny('python -c "os.remove(\'x\')"'));
  assert.ok(deny('node -e "fs.rmSync(\'x\',{recursive:true})"'));
  assert.ok(deny('node --eval "require(\'fs\').unlinkSync(\'x\')"'));
  assert.ok(deny('node -p "require(\'fs\').rmSync(\'x\')"'));
  assert.ok(deny('python3 -c "import shutil; shutil.rmtree(\'x\')"'));
  assert.ok(deny('perl -e "unlink(\'x\')"'));
  assert.ok(deny('ruby -e "File.delete(\'x\')"'));
  assert.ok(deny('php -r "unlink(\'x\')"'));
  assert.ok(deny('deno eval "Deno.remove(\'x\')"'));
  assert.ok(deny('bun -e "require(\'fs\').unlinkSync(\'x\')"'));
});
test('interpreter wrappers without a delete pass', () => {
  assert.ok(allow('node -e "console.log(1)"'));
  assert.ok(allow('python -c "print(1)"'));
  assert.ok(allow('python3 -c "import json; print(json.dumps({}))"'));
  assert.ok(allow('node --version'));
  assert.ok(allow('ruby -e "puts File.exist?(x)"'));
  assert.ok(allow('node -e "console.log(\'rm -rf\')"'));
  assert.ok(allow('echo "node -e fs.rmSync(x)"'));
  assert.ok(allow('Write-Host "python -c os.remove(x)"'));
});
test('interpreter wrappers with extra flags are still detected', () => {
  assert.ok(deny('python -u -c "os.remove(\'x\')"'));
  assert.ok(deny('node --no-warnings -e "fs.rmSync(\'x\')"'));
  assert.ok(allow('python -u -c "print(1)"'));
});
test('dotnet static delete is a single top-level statement when unrecombined', () => {
  assert.ok(allow("[IO.File]::Delete('D:\\tmp\\a.txt')"));
  assert.ok(allow("[System.IO.Directory]::Delete('D:\\tmp\\dir', $true)"));
  assert.ok(deny("[IO.File]::Delete('a'); Get-Date"));
  assert.ok(deny("[IO.File]::Delete('a') | Out-Null"));
  assert.ok(deny('powershell -c "[IO.File]::Delete(\'a\')"'));
  assert.ok(deny('iex "[IO.File]::Delete(\'a\')"'));
  assert.ok(deny("[IO.File]::Delete((Join-Path $d 'a'))"));
});
