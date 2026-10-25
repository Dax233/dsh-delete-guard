# dsh-delete-guard

一个 DeepSeek Harness 插件：**删除语句必须单独执行**，否则在 `tools/pre-execute` 阶段直接拒绝。

## 为什么

危险的删除往往不是"删错了一个文件"，而是**混在别的语句里**被执行：变量拼错、路径为空、
循环里挨个删、`iex` 动态拼出来。命令一旦是复合的，目标就不再显眼。

这个插件的立场是：**递归删除必须是一条独立、可单独审阅的命令**。它拦不住"删错"，但能让"删"这件事本身
无法藏在别的动作里。

## 规则

命令中出现删除动词时，必须是**唯一且顶层**的语句，否则拒绝：

| 维度 | 允许 | 拒绝 |
| --- | --- | --- |
| 语句数 | 一条 | 分号、`&&`、`||`、管道、换行串联 |
| 嵌套 | 顶层 | `{}`、`()`、`$()`、`@()`、`if`/`foreach`/`for`/`while`/`switch`/`try` |
| 包装 | 直接调用 | `-Command`、`-EncodedCommand`、`cmd /c`、`bash -c`、`Start-Process` |
| 动态执行 | — | `Invoke-Expression` / `iex` |
| 调用次数 | 1 次 | 一条命令里多次删除 |

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
```

## 安装

```sh
dsh plugin --profile desktop add github:Dax233/dsh-delete-guard
```

装完**重启 DSH Desktop** 生效。插件在启动时装载，之后所有 shell 工具调用（`pwsh`、`bash`、
`terminal_send` 等）都会先经过这道闸门。

## 配置

`cordis.patch.yml` 里插入插件行：

```yaml
- insert:
    - id: delete-guard
      name: '@local/dsh-delete-guard'
      config:
        enabled: true
        tools: [pwsh, bash, shell, terminal_send]
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭整道闸门 |
| `tools` | `pwsh`、`bash`、`shell`、`cmd`、`terminal_send` | 需要检查命令文本的工具名 |

## 实现

- 挂 `tools/pre-execute` waterfall，返回 `{ kind: 'deny', reason }` 即阻断（不调用 `next()`）。
- 分析逻辑在 `lib/detect.js`，是纯函数：**先掩码引号内字面量**，再在剩余结构里找分隔符/嵌套/删除动词。
  这样路径里的 `a;b` 不会被误判成串联。
- 例外：`iex "..."`、`-Command "..."`、`cmd /c "..."` 这类**会求值字面量**的场景，会回退检查原始文本。
- 分析函数抛异常时 **fail-open**（放行）：守卫出 bug 不能把整个会话卡死。

## 测试

```sh
node --test tests/detect.test.mjs
```

覆盖：单条删除放行、串联/嵌套/包装/动态执行拒绝、多处删除拒绝、引号掩码、
`--rm` 这类 CLI 参数不误判（`docker run --rm` 不是 `rm` 别名）。

## 限制

- 只管 shell 命令。`run_code` 里直接调 `fs.rmSync` 这类不经过 shell 的删除不在范围内。
- 对 `kubectl delete` / `docker rm` 这类**命令子命令**形式的删除，只按"单条命令"判断，
  不会额外识别它们的目标。
- 刻意保守：`Remove-Item (Join-Path $a $b)` 会被拒（括号=分组），改成字面量路径即可。

## License

MIT
