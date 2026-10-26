# dsh-delete-guard

一个 DeepSeek Harness 插件：**删除必须是一条独立、顶层、可见的语句**——shell 命令里如此，`run_code` 里也不例外。违反时在 `tools/pre-execute` 阶段直接拒绝。

## 为什么

危险的删除往往不是"删错了一个文件"，而是**藏在别的语句或程序里**被执行：变量拼错、路径为空、
循环里挨个删、`iex` 动态拼出来，或者干脆在 `run_code` 里调 `fs.rmSync` 绕过 shell。
目标一旦不显眼，审阅就失效了。

这个插件的立场是：**删除必须是一条独立、可单独审阅的 statement**。它拦不住"删错"，但能让"删"这件事本身
无法藏在别的动作里。

## 规则

shell 命令中出现删除动词时，必须是**唯一且顶层**的语句，否则拒绝：

| 维度 | 允许 | 拒绝 |
| --- | --- | --- |
| 语句数 | 一条 | 分号、`&&`、`||`、管道、换行串联 |
| 嵌套 | 顶层 | `{}`、`()`、`$()`、`@()`、`if`/`foreach`/`for`/`while`/`switch`/`try` |
| 包装 | 直接调用 | `-Command`、`-EncodedCommand`、`cmd /c`、`bash -c`、`Start-Process` |
| 解释器包装 | — | `node -e`/`--eval`/`-p`、`python -c`、`perl -e/-E`、`ruby -e`、`php -r`、`deno eval`、`bun -e`（删除藏在被求值的字面量里） |
| 动态执行 | — | `Invoke-Expression` / `iex` |
| 调用次数 | 1 次 | 一条命令里多次删除 |

`[IO.File]::Delete('x')` 这类 .NET 静态调用的括号属于调用语法，单条放行；但把路径再嵌一层表达式
（如 `[IO.File]::Delete((Join-Path ...))`）仍按括号/嵌套规则拒绝。

识别的删除动词：

- PowerShell：`Remove-Item`、`Remove-ItemProperty`、`Clear-RecycleBin`、`[IO.File]::Delete`、`[IO.Directory]::Delete`，以及别名 `ri`/`rm`/`del`/`erase`/`rd`/`rmdir`
- bash：`rm`、`rmdir`、`unlink`、`shred`、`find ... -delete`
- cmd：`del`、`erase`、`rd`、`rmdir`

示例：

```powershell
# 放行：单条、顶层、字面量路径
Remove-Item -LiteralPath 'D:\tmp\a.txt' -Force

# 拒绝
Remove-Item 'a'; Write-Host done          # 分号串联
if ($x) { Remove-Item $x }                # 嵌套在 if
Get-ChildItem | ForEach-Object { Remove-Item $_ }   # 管道 + 块
iex "Remove-Item a"                       # 动态执行
cmd /c del /q a                           # cmd /c 包装
node -e "fs.rmSync('a')"                  # 解释器包装：删除在 node 代码里
```

## run_code / 代码级删除

`run_code`（以及 `codeTools` 配置的同类代码工具）不经过 shell，早先版本看不到代码里的删除。
从 0.2.0 起，代码文本会被静态分析，**命中即拒绝**：

- JS/TS：`rmSync`、`unlinkSync`、`rmdirSync`；`fs`/`fsp`/`fsPromises`/`fsExtra`/`fse`/`promises`
  上的 `rm`/`unlink`/`rmdir`/`remove`/`removeSync`/`emptyDir`；`rimraf`/`rimrafSync`/`rmtree`；
  `.rm(`/`.unlink(`/`.rmdir(` 方法调用；`fs['rmSync']` 这类计算属性调用；
- Python：`shutil.rmtree`、`os.remove`/`os.unlink`/`os.rmdir`、`Path(...).unlink()/rmdir()`；
- 子进程逃逸：调用 `child_process`/`subprocess`/`exec`/`spawn` 等，且命令/参数字符串里出现删除动词
  （`rm`、`rmdir`、`unlink`、`shred`、`del`、`Remove-Item` 等）。

策略是**删除必须回到独立 shell 通道**：

```js
// 拒绝：删除藏在程序里
fs.rmSync('D:/tmp/cache', { recursive: true });
```

```powershell
# 放行：删除单独成条（目标可单独审阅）
Remove-Item -LiteralPath 'D:\tmp\cache' -Recurse -Force
```

拒绝文案会直接给出可操作的改法：把删除改成**独立的一条 shell 删除命令**，非删除逻辑照常留在 `run_code`。
纯读/计算/写文件不受影响；注释与普通字符串里出现 API 名称不算删除（模板字符串 `${...}` 是真实代码，算）。

## 安装

```sh
dsh plugin --profile desktop add github:Dax233/dsh-delete-guard
```

装完**重启 DSH Desktop** 生效。插件在启动时装载，之后所有 shell 工具调用（`pwsh`、`bash`、
`terminal_send` 等）与 `run_code` 都会先经过这道闸门。

## 配置

`cordis.patch.yml` 里插入插件行：

```yaml
- insert:
    - id: delete-guard
      name: '@local/dsh-delete-guard'
      config:
        enabled: true
        tools: [pwsh, bash, shell, terminal_send]
        codeTools: [run_code]
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭整道闸门 |
| `tools` | `pwsh`、`bash`、`shell`、`cmd`、`terminal_send` | 需要检查命令文本的工具名 |
| `codeTools` | `run_code` | 需要检查代码文本的工具名；代码取自参数 `code` |
| `allowRunCodeDeletes` | `false` | 显式放行 `run_code` 里的删除。**风险**：重新打开被反馈的绕过口，仅在明确接受风险时使用 |

> `allowRunCodeDeletes: true` 不是"更宽松的合理配置"，而是逃生舱：它让删除重新可以藏在程序里，
> 本插件的可审阅性保证在该模式下失效。

## 实现

- 挂 `tools/pre-execute` waterfall，返回 `{ kind: 'deny', reason }` 即阻断（不调用 `next()`）。
- shell 分析在 `lib/detect.js`，是纯函数：**先掩码引号内字面量**，再在剩余结构里找分隔符/嵌套/删除动词。
  这样路径里的 `a;b` 不会被误判成串联。
- 代码分析在 `lib/code.js`，同样是纯函数：先掩码注释与字符串字面量（保留结构），再匹配删除 API；
  模板插值 `${...}` 按代码处理。导出 `analyzeRunCode(code) -> { isDelete, verbs, issues }`，可单独单测。
- 会求值字面量的包装（`iex`、`-Command`、`cmd /c`、shell `-c`）回查原文；解释器包装
  （`node -e`、`python -c`、`perl -e`、`ruby -e`、`php -r`、`deno eval`、`bun -e`）把其后的字面量
  当作代码再分析，命中记 `dynamic-literal` 拒绝。
- 分析函数抛异常时 **fail-open**（放行）：守卫出 bug 不能把整个会话卡死。

## 测试

```sh
npm test
```

三个测试文件：`tests/detect.test.mjs`（shell 结构）、`tests/code.test.mjs`（代码级删除）、
`tests/index.test.mjs`（钩子接线、配置与 fail-open）。误报侧（读/写、注释、普通字符串、非删除子进程）
与漏报侧（各类删除 API、包装、串联）都覆盖。

## 限制

- **`write`/`edit` 覆盖写不在本插件范围**：覆盖写没有"独立语句"等价物，属于编辑语义与 fs 观察策略层
  （备份/审批），塞进删除守卫会破坏正常写文件工作流。这是设计边界，不是遗漏。
- 对 `kubectl delete` / `docker rm` 这类**命令子命令**形式的删除，仍只按"单条命令"判断，
  不解析它们的目标。
- `run_code` 分析是静态启发式：常见调用形式能识别，但别名和运行时拼接（`globalThis['r' + 'm']`、
  先 `const f = fs.rmSync` 再调用、Python `from os import remove` 后裸调）无法保证识别。
  `allowRunCodeDeletes: true` 会整体放行该检查。
- 解释器包装只在"被求值字面量里能静态识别出删除 API"时拒绝；多层嵌套、拼接后再 `eval` 的代码
  无法可靠分析。
- 刻意保守：`Remove-Item (Join-Path $a $b)` 会被拒（括号=分组），改成字面量路径即可。

## License

MIT
