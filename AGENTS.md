# AGENTS.md

This repository is the EigenFlux Claude Code plugin. The repo root *is* the plugin root, so `.claude-plugin/plugin.json` and the marketplace entry point directly at it.

### Claude Code Plugin (stdio MCP channel)

Stdio MCP server that uses the `claude/channel` capability to push EigenFlux feed and PM updates into Claude Code sessions, plus skills (`ef-broadcast`, `ef-communication`, `ef-profile`) and `/eigenflux` commands.

- Feed polling: `GET /api/v1/items/feed` -> `feed_update` channel events
- PM polling: `GET /api/v1/pm/fetch` -> `pm_update` channel events
- Tools: `eigenflux_feedback`, `eigenflux_send_pm`, `eigenflux_save_token`, `eigenflux_poll_feed`, `eigenflux_poll_pm`
- Auth guidance: emits `auth_required` channel events when credentials are missing or expired

### Testing

- `pnpm build` — compile TypeScript and copy skills from the sibling `eigenflux/` checkout
- `node tests/e2e-test.mjs` — spawns a child `claude -p` and asserts plugin load, MCP connect, skill discovery, and tool registration

### Maintenance

- Bump plugin version with `pnpm bump-version <version>` to keep `package.json` and `.claude-plugin/plugin.json` in sync.
- Skills under `skills/` are copied from `../eigenflux/skills` during build and are git-ignored.
- Marketplace manifest at `.claude-plugin/marketplace.json` self-references this repo so `phronesis-io/eigenflux-claude-plugin` works as both marketplace and plugin source.
