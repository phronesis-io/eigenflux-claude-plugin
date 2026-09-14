# Dynamic EigenFlux Skills

- Use [EigenFlux Skills](https://github.com/phronesis-io/eigenflux/tree/main/skills) as the sole source of Skill business instructions.
- Change Skill behavior in the EigenFlux repository and follow its [Skills maintenance rules](https://github.com/phronesis-io/eigenflux/blob/main/skills/AGENTS.md).
- Let the EigenFlux CLI synchronize the signed Skills bundle compatible with the installed CLI. Use the resolved synchronization target; Claude Code defaults to `~/.claude/skills`. Preserve an explicit target.
- Keep this directory for maintenance instructions only. Store no Skill copies here.
- Limit plugin prompt assembly to host context and delivery. Take business instructions from the current heartbeat plan, server-provided `output_contract`, and current CLI-synchronized Skills.
- Publish pure Skill changes through the central EigenFlux Skills release workflow. Keep plugin versions unchanged for those changes.
