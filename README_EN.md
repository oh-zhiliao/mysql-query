# MySQL Query — Zhiliao Database Query Plugin

MySQL database query plugin for the [Zhiliao](https://github.com/git-zhiliao/zhiliao) Agent, providing read-only SQL query capabilities.

> [中文版](README.md)

## Features

- **Read-only SQL Queries**: Execute SELECT / SHOW / DESCRIBE / EXPLAIN statements; write operations are rejected
- **Auto LIMIT**: SELECT statements without LIMIT get one automatically (default 100, max 1000) to prevent full table scans
- **Multi-database Support**: Reference configured databases by friendly names
- **Knowledge System**: Three-layer knowledge loading — on-demand doc loading saves tokens
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
    {db_name}/
      _catalog.md          # tables, conventions, doc index (always loaded)
      {doc-name}.md        # task-oriented query pattern docs (loaded on-demand)
```

## Knowledge Architecture (3 Layers)

| Layer | Source | Loading | Content |
|---|---|---|---|
| Plugin-level | hardcoded in code | always | SQL syntax rules, safety restrictions, general tips |
| Database catalog | `knowledge/{db}/_catalog.md` | always | table schema, project conventions, doc index |
| Task-based docs | `knowledge/{db}/{doc}.md` | on-demand | detailed query patterns, analysis recipes, investigation playbooks |

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
- `accounts.default` is used when no role is present in the request context
- If Zhiliao passes a `role`, the plugin looks for `accounts.<role>` first
- If the role is not `default` and no matching account exists, the query is rejected; it does not silently downgrade to `default`
- Legacy top-level `user/password` has been removed and must be migrated to `accounts.default`

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

# If knowledge files are present:
# Knowledge loaded for "my_app": catalog + N docs
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

For the full authoring guide (directory structure, file formats, naming conventions, content layering rules), see [`knowledge/CLAUDE.md`](knowledge/CLAUDE.md).
