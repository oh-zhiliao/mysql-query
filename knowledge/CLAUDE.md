# MySQL Query Knowledge Authoring Guide

This directory contains database-specific knowledge for the MySQL query plugin. The knowledge is loaded by the zhiliao agent to help it write better SQL queries.

## Structure

```
knowledge/
  CLAUDE.md                     # this file
  {db_name}/                    # directory name must match key in config.yaml known_databases
    _catalog.md                 # required: tables, conventions, doc index (always loaded into system prompt)
    {doc-name}.md               # optional: task-based knowledge docs (loaded on-demand)
```

## Adding a New Database

1. Create a directory matching the database name in `config.yaml`
2. Create `_catalog.md` with the required format (see below)
3. Optionally add task-based doc files

## _catalog.md Format

```markdown
---
description: One-line description of what this database contains
---

## Tables

- `table_name`: What it stores, key columns, relationships
- `another_table`: Description

## Conventions

- Naming patterns (e.g. "tables use snake_case, IDs are bigint unsigned")
- Data format notes (e.g. "timestamps are UTC, stored as datetime")
- Soft-delete patterns (e.g. "deleted_at IS NULL means active")
- Sharding or partition notes

## Available Docs

- **doc-name**: One-line description of what patterns/recipes this doc contains
- **another-doc**: Description
```

**Important**: The catalog body (Tables, Conventions, Available Docs sections) is loaded into the agent's system prompt on every turn. Keep it concise — list table names with brief descriptions, not full schema dumps. Put detailed examples in task-based docs instead.

## Task-Based Doc Format

Organize docs by what the agent is trying to accomplish, not by knowledge type:

```markdown
---
title: Human-Readable Title
description: One-line description (shown in tool's available docs list)
---

### Pattern Name

Brief explanation of when to use this pattern.

\`\`\`sql
SELECT query example
\`\`\`

### Another Pattern

...
```

**Good doc names** (task-oriented): `user-analysis`, `order-stats`, `performance-investigation`, `data-quality-checks`

**Bad doc names** (type-oriented): `queries`, `tables`, `examples` — these belong in `_catalog.md`

## Updating Knowledge

- Edit files in place. The plugin reads them at startup.
- Keep `_catalog.md` frontmatter `description` in sync with content.
- Keep the "Available Docs" section in `_catalog.md` in sync with actual doc files.
- If you add a new `.md` file, add a corresponding entry in the Available Docs section.

## What Goes Where

| Content | Location | Why |
|---|---|---|
| Table names + brief descriptions | `_catalog.md` Tables section | Always needed for any query |
| Naming conventions, data formats | `_catalog.md` Conventions section | Always relevant context |
| Doc index with summaries | `_catalog.md` Available Docs section | LLM decides what to load |
| SQL syntax tips | Plugin code (shared across all databases) | Not database-specific |
| Complex query patterns | Task-based doc files | Loaded on-demand to save tokens |
| Investigation playbooks | Task-based doc files | Loaded on-demand when needed |
