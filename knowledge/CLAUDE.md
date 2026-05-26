# MySQL Query Knowledge Authoring Guide

This directory contains database-specific knowledge for the MySQL query plugin. The knowledge is loaded by the zhiliao agent to help it write better SQL queries.

## Structure

```
knowledge/
  CLAUDE.md                     # this file
  {alias}/                      # directory name must match key in config.yaml known_databases
    common/                     # optional shared knowledge
      _catalog.md               # required if common docs exist
      {doc-name}.md
    roles/
      default/                  # default-role knowledge
        _catalog.md             # required if role docs exist
        {doc-name}.md
      complaint/                # role-specific knowledge
        _catalog.md
        {doc-name}.md
```

## Adding a New Database

1. Create a directory matching the alias in `config.yaml`
2. Create `roles/<role>/_catalog.md` for each role-specific scope you want to expose
3. Optionally add `common/_catalog.md` plus shared docs if `allow_common_knowledge=true`
4. Add task-based doc files under the same scope

Knowledge directories remain keyed by configured alias, not by runtime physical database.
If one alias can query multiple physical databases, document the default physical database and common alternatives in the relevant role catalog.

## Scope Catalog Format

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

**Important**:

- The current role only sees catalogs from its own `roles/<role>/` scope
- `common/_catalog.md` is only visible when `allow_common_knowledge=true`
- Keep catalog bodies concise; put detailed examples in task-based docs instead

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

- Edit files in place.
- Keep each scope `_catalog.md` frontmatter `description` in sync with content.
- Keep the "Available Docs" section in each scope catalog in sync with actual doc files in that scope.
- If you add a new `.md` file, add a corresponding entry in the same scope catalog.
- Changes take effect only after `/mysql-query reload-knowledge` or agent restart.

## What Goes Where

| Content | Location | Why |
|---|---|---|
| Table names + brief descriptions | `roles/<role>/_catalog.md` or `common/_catalog.md` | Scope-specific context |
| Naming conventions, data formats | Scope catalog Conventions section | Scope-specific context |
| Doc index with summaries | Scope catalog Available Docs section | LLM decides what to load |
| SQL syntax tips | Plugin code (shared across all databases) | Not database-specific |
| Complex query patterns | Task-based doc files | Loaded on-demand to save tokens |
| Investigation playbooks | Task-based doc files | Loaded on-demand when needed |
