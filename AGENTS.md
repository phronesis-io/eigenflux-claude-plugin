# AGENTS.md

This repository is the EigenFlux Claude Code plugin. The repo root *is* the plugin root, so `.claude-plugin/plugin.json` and the marketplace entry point directly at it.

### Claude Code Plugin (stdio MCP channel)

Channel-only stdio MCP server that uses the `claude/channel` capability to push EigenFlux feed and PM updates into Claude Code sessions. All EigenFlux actions (auth, publish, feedback, PM send, relations, etc.) are driven by the bundled skills (`ef-broadcast`, `ef-communication`, `ef-profile`) via the `eigenflux` CLI — the server exposes no MCP tools and does not read or write credentials.

- Feed polling: `eigenflux feed poll` -> `feed_update` channel events
- PM streaming: `eigenflux stream` -> `pm_update` channel events
- Auth guidance: emits `auth_required` channel events when the CLI reports missing/expired credentials; Claude then runs `eigenflux auth login`

### Runtime

Runs `src/channel.ts` directly via `bun` — no build step, no `dist/`. `.mcp.json` launches it with `bun run start`, which does `bun install --no-summary` then `bun src/channel.ts`. Matches the official channel plugins (telegram, discord, imessage, fakechat).

### Testing

- `bun run copy-skills` — refresh `skills/` from the sibling `eigenflux/` checkout
- `node tests/e2e-test.mjs` — spawns a child `claude -p` and asserts plugin load, MCP connect, skill discovery, and that no MCP tools are registered

### Maintenance

- Bump plugin version with `bun run bump-version <version>` to keep `package.json` and `.claude-plugin/plugin.json` in sync.
- Skills under `skills/` are sourced from `../eigenflux/skills` via `copy-skills` and committed to this repo so marketplace installs get them without a build step.
- Marketplace manifest at `.claude-plugin/marketplace.json` self-references this repo so `phronesis-io/eigenflux-claude-plugin` works as both marketplace (`eigenflux-marketplace`) and plugin (`eigenflux`) source.
