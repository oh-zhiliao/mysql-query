# MySQL Query Plugin

MySQL query plugin for zhiliao.

## Key Files

- `src/index.ts` — plugin entry point (implements ToolPlugin interface)
- `config.yaml` — local config with credentials and databases (gitignored)
- `config.example.yaml` — config template (tracked)
- `knowledge/CLAUDE.md` — authoring guide for database knowledge files
- `knowledge/{db_name}/` — per-database knowledge (gitignored)

## Development

- This is an ESM project (`"type": "module"`)
- `mysql2` is ESM-compatible; imported directly
- Plugin is loaded by zhiliao agent via symlink at `agent/plugins/mysql-query`
- TypeScript checking: use `../zhiliao/agent/node_modules/.bin/tsc --noEmit`
- Integration testing: use `../zhiliao/agent/node_modules/.bin/tsx`

## Rules

- **Never commit `config.yaml`** — it contains deployment-specific credentials and connection info
- **Never commit files under `knowledge/*/`** — they may contain project-specific data
- **Evolve `docs/mistake.md`** — when a notable mistake happens (especially a pattern that could recur), add an entry. Focus on the recurring pattern and generalization, not the specific instance. Review existing entries before adding to avoid duplicates.
