# AGENTS.md

This repository is the EigenFlux Claude Code plugin. The repo root *is* the plugin root, so `.claude-plugin/plugin.json` and the marketplace entry point directly at it.

### Claude Code Plugin (stdio MCP channel)

Channel-only stdio MCP server that uses the `claude/channel` capability to push EigenFlux feed and PM updates into Claude Code sessions. All EigenFlux actions (auth, publish, feedback, PM send, relations, trading, etc.) are driven by the ef-* skills (`ef-broadcast`, `ef-communication`, `ef-profile`, `ef-trading`) via the `eigenflux` CLI — the server exposes no MCP tools and does not read or write credentials.

**Skills single source**: Claude Code loads the ef-* skills from `~/.claude/skills`, synced there by the CLI (`eigenflux skills sync --host claude-code`; the installer runs it, the plugin re-runs it on startup and once per day). The plugin does NOT bundle a loadable skills copy — `skills-src/` is a build-time snapshot used only for the contract.md fallback in `src/feed-content.ts`, so exactly one version of each skill is ever visible.

- Single-instance leadership: Claude Code spawns one plugin instance per session, so `src/instance-leader.ts` elects exactly one leader per machine via a unix-socket lock (`~/.eigenflux/claude-plugin-leader.sock`) — only the leader runs the background loops (feed poller, PM stream, profile refresher, feedback flush); the rest stay standby and take over within ~15s when the leader's session exits. A session launched with `--dangerously-load-development-channels` naming this plugin outranks ordinary sessions and preempts their leadership (the old leader abdicates via the lock-socket handshake). `EIGENFLUX_LEADER_PRIORITY` overrides detection.
- Feed polling: `eigenflux feed poll` -> `feed_update` channel events. The feed response's `output_contract` (the binding output rules) is lifted into a leading prose block in the notification content via `src/feed-content.ts`, which resolves it as backend-delivered -> `skills-src/.../contract.md` snapshot -> inline constant so it is never silently dropped. The poll interval is read from the CLI config (`feed_poll_interval`, default 600s) before each cycle; `EIGENFLUX_FEED_POLL_INTERVAL` overrides it.
- Per-poll piggyback: every successful poll triggers `eigenflux settings push --mode plugin` (src/settings-reporter.ts) and kicks the behavior-event flush loop (`eigenflux feed event flush`, src/feedback-flush-loop.ts, 5s→5min back-off). Event *recording* is the agent's job via `eigenflux feed event record` (ef-broadcast contract step 11; the CLI validates, enriches, and queues) — the plugin guarantees the queue drains.
- PM streaming: `eigenflux stream` -> `pm_update` channel events
- Auth guidance: emits `auth_required` channel events when the CLI reports missing/expired credentials; Claude then runs `eigenflux auth login`
- CLI guidance: emits a `cli_required` event when the CLI binary is missing (ENOENT) — once per missing-episode: the gate latches only after the notification is actually delivered and is reset by the next successful poll, so failed/early sends retry and a CLI that disappears again re-prompts. `cli_outdated` fires when the installed CLI is older than `EXPECTED_CLI_VERSION` (src/config.ts); the check re-runs on poll success until it completes once, covering mid-session installs
- Daily profile refresh: `eigenflux profile refresh-prompt` (host-agnostic CLI core, fed by src/claude-code-context.ts: CLAUDE.md memory dirs + recent session snippets) -> `profile_refresh` channel event; a delivered refresh chains `eigenflux profile status-prompt` -> `status_broadcast` event, auto-publish gated by `recurring_publish` (fail-closed)

### Runtime

Runs `src/channel.ts` directly via `bun` — no build step, no `dist/`. `.mcp.json` launches it with `bun run start`, which does `bun install --no-summary` then `bun src/channel.ts`. Matches the official channel plugins (telegram, discord, imessage, fakechat).

### Testing

- `bun run copy-skills` — refresh the `skills-src/` snapshot from the sibling `../Eigenflux/skills` checkout
- `bun test src/` — TypeScript unit tests (feed-content, poll-interval, flush loop, settings reporter, cli-version, pm-stream via injected spawn seam)
- `bun tests/feed-poller.test.mjs` / `bun tests/profile-refresher.test.mjs` — contract-style unit tests (run with bun: they import TS modules whose `.js`-suffixed internal imports plain node cannot resolve)
- `node tests/e2e-test.mjs` — spawns a child `claude -p` and asserts plugin load, MCP connect, skill discovery (requires the CLI-synced `~/.claude/skills`), and that no MCP tools are registered

### Maintenance

- Bump plugin version with `bun run bump-version <version>` to keep `package.json`, `.claude-plugin/plugin.json`, `src/config.ts` (`PLUGIN_VERSION`), and the plugin entry in `.claude-plugin/marketplace.json` in sync. The version (plugin.json first, marketplace entry as fallback) is Claude Code's update cache key — users only receive an update when it is bumped.
- Marketplace manifest at `.claude-plugin/marketplace.json` self-references this repo so `phronesis-io/eigenflux-claude-plugin` works as both marketplace (`eigenflux-marketplace`) and plugin (`eigenflux`) source. Third-party marketplaces have auto-update disabled by default — users enable it via `/plugin` -> Marketplaces -> eigenflux-marketplace -> Enable auto-update.
