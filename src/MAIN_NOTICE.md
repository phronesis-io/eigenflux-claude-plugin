# 主对话通知

修改逻辑时同步本文。

- CLI 通过 ACP v1 的 `ai.eigenflux.mainConversation` 扩展连接本插件；仅支持精确的 `sessionId`、真实 `cwd`。
- `SessionStart`、`Stop` 的官方 `asyncRewake` hook 保持本会话监听。收到通知后写入隐藏 system reminder 并退出 2；只显示 Agent 的处理结果。不中转普通 channel，不启动或恢复另一 Claude 进程。
- `UserPromptSubmit` 使未完成通知失效。`SessionEnd`、`StopFailure` 关闭入口。`Stop.last_assistant_message` 只作为已注入通知的回执；与上次答复相同、错会话、错代次、超时均不报成功。
- 所有进程使用同一 `EIGENFLUX_HOME`；数据在其 `claude-main-notice/bridge.sqlite`。可显式设置绝对路径 `EIGENFLUX_MAIN_BRIDGE_HOME`。不读账号凭据或会话文件。
- 私有 SQLite 事务串行交接；每个 `requestId` 只尝试一次。空闲监听租约 6 秒，处理等待最多 3 分钟。交接前检查调用进程仍存活；用户输入、崩溃、超时不自动重发，不中断宿主正在执行的回合。
- 单次监听最多 24 小时；到期后入口不可用，下次会话开始或响应完成再监听。已交给宿主的回合无法撤回。
- 目前是已实现、尚未真机验收；入口只读执行 `claude --version`，保守要求 Claude Code ≥2.1.295，且实际支持 `asyncRewake`、exec-form `args`。`async:true` 保护旧版不被监听进程阻塞；旧版或未知版本不注册入口。Windows 需可直接执行的原生 CLI，目录 ACL、唤醒、隐藏与回执需分别实测。不能把 CodeBuddy/WorkBuddy 当作同能力宿主。
- 包装安装可显式设置 `EIGENFLUX_CLAUDE_VERSION_COMMAND` 为版本查询的 JSON argv，首项必须为绝对路径；不经 shell，不执行通知中的命令。

入口：`bun <插件绝对路径>/src/main-notice-acp.ts`。`initialize` 后仅接受 `_eigenflux/main/inspect`、`_eigenflux/main/notify`；不支持 `session/new`、`session/load`、`session/prompt`。

测试：`bun test src/main-notice.test.ts`。只用临时目录和伪 hook，不调用模型、不安装插件。

官方依据：[command hooks](https://code.claude.com/docs/en/hooks#command-hook-fields)、[async hooks](https://code.claude.com/docs/en/hooks#limitations)、[Stop 回执](https://code.claude.com/docs/en/hooks#stop-input)、[ACP 扩展](https://agentclientprotocol.com/protocol/v1/extensibility)。
