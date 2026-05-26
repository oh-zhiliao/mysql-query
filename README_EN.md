# MySQL Query — Zhiliao Database Query Plugin

MySQL database query plugin for the [Zhiliao](https://github.com/git-zhiliao/zhiliao) Agent, providing read-only SQL query capabilities.

> [中文版](README.md)

## Features

- **Read-only SQL Queries**: Execute SELECT / SHOW / DESCRIBE / EXPLAIN statements; write operations are rejected
- **Auto LIMIT**: SELECT statements without LIMIT get one automatically (default 100, max 1000) to prevent full table scans
- **Multi-database Support**: Reference configured databases by friendly names
- **Knowledge System**: Role-scoped knowledge isolation with on-demand doc loading to reduce blind probing
- **Role-based DB Accounts**: A single database alias can map to different query accounts by `role`
- **Runtime Database Selection**: Config keys represent connection aliases; the physical database can be chosen at query time with `instance + optional database`
- **Connection Pooling**: Independent pool per database-alias, role, and physical-database combination with automatic lifecycle management

## Tools Provided

| Tool | Description | Cost |
|---|---|---|
| `mysql-query.query` | Execute read-only SQL query | expensive |
| `mysql-query.get_topic_knowledge` | Load detailed query pattern docs for a database on-demand | cheap |

## Directory Structure

```
mysql-query/
  config.yaml              # database connections (gitignored)
  config.example.yaml      # config template
  src/index.ts             # TypeScript plugin entry point
  package.json             # dependencies (mysql2)
  knowledge/               # knowledge directory (gitignored, managed separately)
    CLAUDE.md              # authoring guide for knowledge files
    {alias}/
      common/              # optional shared knowledge, only visible when allow_common_knowledge=true
        _catalog.md
        {doc-name}.md
      roles/
        default/           # default-role knowledge
          _catalog.md
          {doc-name}.md
        complaint/         # complaint-role knowledge
          _catalog.md
          {doc-name}.md
```

## Role-Scoped Knowledge

| Layer | Source | Loading | Content |
|---|---|---|---|
| Plugin-level | hardcoded in code | always | SQL syntax rules, safety restrictions, general tips |
| Role scope | `knowledge/{alias}/roles/{role}/_catalog.md` | visible only to the current role | schema, conventions, doc index |
| Common scope | `knowledge/{alias}/common/*.md` | visible only when `allow_common_knowledge=true` | non-sensitive shared knowledge |
| Task-based docs | `roles/{role}/{doc}.md` / `common/{doc}.md` | on-demand | detailed query patterns, analysis recipes, investigation playbooks |

Rules:

- Strict isolation by default: only `roles/<role>/...` is loaded
- When `allow_common_knowledge: true`, `common/...` is merged on top of the role scope
- The `query` tool only advertises aliases visible to the current role
- If an alias is queryable but its knowledge has not been migrated yet, the tool description falls back to `configured database alias` and logs `knowledge missing`

## Safety Mechanisms

- **Read-only enforcement**: Only `SELECT`, `SHOW`, `DESCRIBE`, `DESC`, `EXPLAIN`, `WITH` (CTE) statements allowed
- **Write interception**: `INSERT`, `UPDATE`, `DELETE`, `DROP`, `CREATE`, `ALTER`, `TRUNCATE` etc. are all rejected
- **Password filtering**: All database passwords are auto-masked via secret patterns
- **Fail-closed authorization**: If a non-default role is present but the database has no matching account, the query is rejected instead of falling back to `default`
- **Query timeout**: Configurable per database (default 30s)

---

## Agent Guide: Deployment

For agents or operators responsible for deploying the plugin.

### Prerequisites

- Zhiliao Agent runtime (Node.js + tsx)
- Read-only MySQL database credentials

### Installation

```bash
# 1. Clone into plugins directory
cd agent/plugins/
git clone git@github.com:git-zhiliao/mysql-query.git mysql-query

# 2. Install dependencies
cd mysql-query && npm install && cd ..

# 3. Configure
cp mysql-query/config.example.yaml mysql-query/config.yaml
# Edit config.yaml with real connection info
```

### Configuration

Edit `config.yaml`:

```yaml
allow_common_knowledge: false

known_databases:
  my_app:
    host: "127.0.0.1"
    port: 3306
    database: "my_app_db"   # optional default physical database
    accounts:
      default:
        user: "${MYSQL_USER}"
        password: "${MYSQL_PASSWORD}"
      finance_admin:
        user: "${MYSQL_FINANCE_ADMIN_USER}"
        password: "${MYSQL_FINANCE_ADMIN_PASSWORD}"
    # connect_timeout: 10000   # Connection timeout in ms (default: 10000)
    # query_timeout: 30000     # Query timeout in ms (default: 30000)
```

Notes:

- `known_databases.<key>` uses `<key>` as the connection alias, not as a fixed physical database name
- Config `database` is only the default physical database; queries may explicitly target another physical database
- `accounts.default` is used by default/legacy callers
- If Zhiliao passes a `role`, the plugin looks for `accounts.<role>` first
- If the role is not `default` and no matching account exists, the query is rejected; it does not silently downgrade to `default`
- An alias may be configured only for a non-default role; such an alias is hidden from default callers
- Legacy top-level `user/password` has been removed and must be migrated to `accounts.default`
- `allow_common_knowledge` defaults to `false`, so knowledge stays role-isolated unless explicitly relaxed

Preferred query shape:

```json
{ "instance": "doris", "database": "wizard", "sql": "SELECT COUNT(*) FROM pay_users" }
```

Legacy-compatible query shape:

```json
{ "database": "doris", "sql": "SELECT COUNT(*) FROM pay_users" }
```

Additional notes:

- In the new shape, `instance` means the connection alias and `database` means the physical target database for this query
- In the legacy shape, `database=<alias>` still works, but the physical database can only come from the configured default `database`
- The code keeps a few compatibility comments on purpose because the transition period has two meanings for `database`, and that is otherwise easy to misread

### Verification

```bash
# After starting the Zhiliao Agent, check logs
docker compose logs agent | grep "Plugin loaded"
# Expected: Plugin loaded: mysql-query (1 tools)
# Or (with knowledge): Plugin loaded: mysql-query (2 tools)

# If knowledge files are present, you will also see role-scoped logs such as:
# [mysql-query] knowledge resolved: role=default alias=my_app scope=role docs=N
```

### Docker Deployment

Mount the plugins directory into the container:

```yaml
services:
  agent:
    volumes:
      - ./agent/plugins:/app/plugins
    environment:
      - MYSQL_USER=readonly_user
      - MYSQL_PASSWORD=your-password
```

---

## Agent Guide: Knowledge Maintenance

The `knowledge/` directory is gitignored and managed independently from the plugin code. It can be managed as a separate git repo, generated by an external agent at deploy time, or maintained manually.

Knowledge changes only become visible after:

- an admin runs `/mysql-query reload-knowledge`
- or the agent is restarted

For the full authoring guide (directory structure, file formats, naming conventions, content layering rules), see [`knowledge/CLAUDE.md`](knowledge/CLAUDE.md).
