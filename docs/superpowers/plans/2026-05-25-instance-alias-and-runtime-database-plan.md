# Instance Alias and Runtime Database Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `mysql-query` route by role-aware account on a configured alias, while selecting the physical database at runtime via `instance + optional database` and preserving legacy `database=<alias>` callers.

**Architecture:** Keep `known_databases.<key>` as the configured alias and make `database` optional as the config default physical database. Query execution resolves `(alias, account, physical_database)` first, validates the physical database name, and then uses a pool keyed by those three values to avoid connection-state bleed. Knowledge loading remains alias-based, and the query tool keeps a compatibility path for legacy callers.

**Tech Stack:** TypeScript, Vitest, mysql2/promise, zhiliao `ToolPlugin` shim

---

## File Map

- Modify: `src/index.ts`
  - make config `database` optional
  - add alias/physical-database resolution helpers
  - validate runtime database names
  - switch query contract to `instance + optional database` with legacy compatibility
  - change pool keys to include resolved database
  - add explanatory compatibility comments
- Modify: `tests/role-accounts.test.ts`
  - add red tests for new query contract, legacy compatibility, missing defaults, invalid database names, and per-database pool isolation
- Modify: `tests/security.test.ts`
  - update query call examples to use `instance` where appropriate
  - assert result headers and summaries do not leak secrets while distinguishing alias vs physical database
- Modify: `tests/knowledge-dir.test.ts`
  - keep alias-based knowledge behavior explicit
- Modify: `config.example.yaml`
  - show optional default `database`
  - document `instance + optional database` usage
- Modify: `README.md`
  - explain alias/default-database split, legacy compatibility, and comments rationale
- Modify: `README_EN.md`
  - same as Chinese README
- Modify: `knowledge/CLAUDE.md`
  - note that knowledge remains alias-based and catalogs should mention default/alternate physical databases

### Task 1: Lock the New Query Contract with Failing Tests

**Files:**
- Modify: `tests/role-accounts.test.ts`
- Test: `tests/role-accounts.test.ts`

- [ ] **Step 1: Add failing tests for the new `instance + database` contract**

Extend `tests/role-accounts.test.ts` with:

```ts
it("uses an explicit physical database when instance is provided", async () => {
  const result = await plugin.executeTool("query", {
    instance: "mydb",
    database: "reporting",
    sql: "SELECT 1",
  }, {
    channel: "feishu",
    userId: "ou-admin",
    role: "finance_admin",
    logId: "log1",
  });

  expect(createPoolMock).toHaveBeenCalledWith(expect.objectContaining({
    database: "reporting",
    user: "finance_user",
  }));
  expect(result).toContain("instance: mydb");
  expect(result).toContain("database: reporting");
});

it("uses the config default database when instance is provided without database", async () => {
  const result = await plugin.executeTool("query", {
    instance: "mydb",
    sql: "SELECT 1",
  });

  expect(createPoolMock).toHaveBeenCalledWith(expect.objectContaining({
    database: "warehouse",
  }));
  expect(result).toContain("database: warehouse");
});

it("keeps legacy database=alias callers working", async () => {
  const result = await plugin.executeTool("query", {
    database: "mydb",
    sql: "SELECT 1",
  });

  expect(createPoolMock).toHaveBeenCalledWith(expect.objectContaining({
    database: "warehouse",
  }));
  expect(result).toContain("mode: legacy");
});
```

- [ ] **Step 2: Add failing tests for missing/defaultless physical database resolution**

In the same file, add:

```ts
it("rejects queries that provide neither instance nor legacy database alias", async () => {
  const result = await plugin.executeTool("query", {
    sql: "SELECT 1",
  });

  expect(result).toMatch(/must provide instance or legacy database alias/i);
});

it("rejects unknown instances before pool creation", async () => {
  const result = await plugin.executeTool("query", {
    instance: "missing",
    database: "warehouse",
    sql: "SELECT 1",
  });

  expect(result).toMatch(/unknown database alias "missing"/i);
  expect(createPoolMock).not.toHaveBeenCalled();
});

it("rejects legacy callers when the alias has no default database", async () => {
  const noDefaultPlugin = new MySQLQueryPlugin();
  noDefaultPlugin.name = "mysql-query";
  await noDefaultPlugin.init({
    known_databases: {
      nodb: {
        host: "127.0.0.1",
        accounts: {
          default: { user: "readonly_user", password: "secret123" },
        },
      },
    },
  });

  const result = await noDefaultPlugin.executeTool("query", {
    database: "nodb",
    sql: "SELECT 1",
  });

  expect(result).toMatch(/no target database/i);
});
```

- [ ] **Step 3: Add failing tests for database-name validation and pool isolation**

Also add:

```ts
it("rejects invalid physical database names before pool creation", async () => {
  const result = await plugin.executeTool("query", {
    instance: "mydb",
    database: "wizard;drop",
    sql: "SELECT 1",
  });

  expect(result).toMatch(/invalid physical database name/i);
  expect(createPoolMock).not.toHaveBeenCalled();
});

it("creates separate pools for the same alias/account when physical databases differ", async () => {
  await plugin.executeTool("query", {
    instance: "mydb",
    database: "warehouse",
    sql: "SELECT 1",
  }, {
    channel: "feishu",
    userId: "ou-admin",
    role: "finance_admin",
    logId: "log-warehouse",
  });

  await plugin.executeTool("query", {
    instance: "mydb",
    database: "reporting",
    sql: "SELECT 1",
  }, {
    channel: "feishu",
    userId: "ou-admin",
    role: "finance_admin",
    logId: "log-reporting",
  });

  expect(createPoolMock).toHaveBeenCalledTimes(2);
  expect(createPoolMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ database: "warehouse" }));
  expect(createPoolMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ database: "reporting" }));
});

it("reuses the same pool when new and legacy inputs resolve to the same alias/database/account", async () => {
  const instanceResult = await plugin.executeTool("query", {
    instance: "mydb",
    database: "warehouse",
    sql: "SELECT 1",
  }, {
    channel: "feishu",
    userId: "ou-admin",
    role: "finance_admin",
    logId: "log-new-shape",
  });

  const legacyResult = await plugin.executeTool("query", {
    database: "mydb",
    sql: "SELECT 1",
  }, {
    channel: "feishu",
    userId: "ou-admin",
    role: "finance_admin",
    logId: "log-legacy-shape",
  });

  expect(instanceResult).toContain("| col1 |");
  expect(legacyResult).toContain("| col1 |");
  expect(createPoolMock).toHaveBeenCalledTimes(1);
  expect(createPoolMock).toHaveBeenCalledWith(expect.objectContaining({
    database: "warehouse",
    user: "finance_user",
  }));
});
```

- [ ] **Step 4: Run the focused tests to verify they fail**

Run:

```bash
cd /home/felix021/.config/superpowers/worktrees/mysql-query/role-based-db-accounts
npm test -- tests/role-accounts.test.ts
```

Expected: FAIL because `src/index.ts` still expects `database` to be the alias, still requires config `database`, and still keys pools without the resolved physical database.
The `noDefaultPlugin.init(...)` case should currently fail at init time because aliases still require a configured default database before Task 2 relaxes that validation.

- [ ] **Step 5: Commit the red tests**

```bash
git add tests/role-accounts.test.ts
git commit -m "test: cover instance alias query resolution"
```

### Task 2: Make Config Default Databases Optional

**Files:**
- Modify: `src/index.ts`
- Test: `tests/role-accounts.test.ts`

- [ ] **Step 1: Relax the config type and init validation**

In `src/index.ts`, change:

```ts
interface DatabaseConfig {
  host: string;
  port?: number;
  database: string;
  connect_timeout?: number;
  query_timeout?: number;
  accounts: Record<string, AccountConfig>;
}
```

to:

```ts
interface DatabaseConfig {
  host: string;
  port?: number;
  database?: string;
  connect_timeout?: number;
  query_timeout?: number;
  accounts: Record<string, AccountConfig>;
}
```

and change init validation from:

```ts
if (!db.host || !db.database) {
  throw new Error(`Database "${name}" missing required fields (host, database)`);
}
```

to:

```ts
if (!db.host) {
  throw new Error(`Database "${name}" missing required field (host)`);
}
```

- [ ] **Step 2: Run the focused tests to verify the red tests still fail for the intended reasons**

Run:

```bash
cd /home/felix021/.config/superpowers/worktrees/mysql-query/role-based-db-accounts
npm test -- tests/role-accounts.test.ts
```

Expected: still FAIL, but no longer because `database` is required at init time. The remaining failures should now come from the old alias-only query contract and pool behavior.

- [ ] **Step 3: Commit the config-typing change**

```bash
git add src/index.ts
git commit -m "refactor: allow mysql aliases without default database"
```

### Task 3: Resolve Alias, Physical Database, and Compatibility Mode

**Files:**
- Modify: `src/index.ts`
- Test: `tests/role-accounts.test.ts`

- [ ] **Step 1: Add resolution helpers with explicit compatibility comments**

In `src/index.ts`, add:

```ts
const DATABASE_NAME_RE = /^[A-Za-z0-9_-]+$/;

interface ResolvedQueryTarget {
  alias: string;
  physicalDatabase: string;
  legacyMode: boolean;
}

private resolveQueryTarget(input: Record<string, any>): ResolvedQueryTarget {
  const requestedInstance = input.instance;
  const legacyAlias = input.database;

  if (!requestedInstance && !legacyAlias) {
    throw new Error("Query must provide instance or legacy database alias.");
  }

  // Keep accepting legacy `database=<alias>` callers so existing sessions and
  // prompts keep working while the tool description migrates toward `instance`.
  const alias = requestedInstance || legacyAlias;
  const legacyMode = !requestedInstance;
  const dbConfig = this.config.known_databases[alias];
  if (!dbConfig) {
    throw new Error(`Unknown database alias "${alias}".`);
  }

  // In compatibility mode, `database` was historically the alias field, so the
  // physical database must come from config instead of the user input payload.
  const physicalDatabase = requestedInstance
    ? (input.database || dbConfig.database)
    : dbConfig.database;
  if (!physicalDatabase) {
    throw new Error(`No target database resolved for alias "${alias}". Specify database explicitly or configure a default database.`);
  }
  if (!DATABASE_NAME_RE.test(physicalDatabase)) {
    throw new Error(`Invalid physical database name "${physicalDatabase}".`);
  }

  return { alias, physicalDatabase, legacyMode };
}
```

- [ ] **Step 2: Update summary formatting to show alias, database, and legacy mode**

Replace the current `summarizeInput(...)` query branch with:

```ts
const instance = input.instance || input.database || "?";
const maybePhysical = input.instance ? (input.database || "(default)") : "(legacy default)";
const sql = input.sql || "";
const preview = sql.length > 80 ? sql.slice(0, 80) + "..." : sql;
return `MySQL query: instance=${instance} database=${maybePhysical}${input.instance ? "" : " mode=legacy"} — ${preview}`;
```

- [ ] **Step 3: Run the focused tests to verify target-resolution tests go green**

Run:

```bash
cd /home/felix021/.config/superpowers/worktrees/mysql-query/role-based-db-accounts
npm test -- tests/role-accounts.test.ts
```

Expected: still FAIL for the same reasons as after Task 2, because `resolveQueryTarget(...)` is not wired into `executeQuery(...)` or the query tool schema yet.

- [ ] **Step 4: Commit the resolution helpers**

```bash
git add src/index.ts
git commit -m "feat: resolve mysql query aliases and runtime databases"
```

### Task 4: Key Pools by Resolved Physical Database and Update Query Execution

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/security.test.ts`
- Test: `tests/role-accounts.test.ts tests/security.test.ts`

- [ ] **Step 1: Update pool keys and account lookup**

In `src/index.ts`, change:

```ts
private buildPoolKey(dbName: string, accountKey: string): string {
  return `${dbName}\u0000${accountKey}`;
}
```

to:

```ts
private buildPoolKey(alias: string, accountKey: string, physicalDatabase: string): string {
  return `${alias}\u0000${accountKey}\u0000${physicalDatabase}`;
}
```

and change the display helper to include the database:

```ts
private describePoolKey(poolKey: string): string {
  const [alias, accountKey, physicalDatabase] = poolKey.split("\u0000");
  if (!accountKey || !physicalDatabase) {
    return poolKey;
  }
  return `${alias} (role=${accountKey}, database=${physicalDatabase})`;
}
```

- [ ] **Step 2: Update pool creation to use the resolved physical database**

Replace `getOrCreatePool(...)` with:

```ts
private getOrCreatePool(alias: string, accountKey: string, physicalDatabase: string): Pool {
  const poolKey = this.buildPoolKey(alias, accountKey, physicalDatabase);
  const existing = this.pools.get(poolKey);
  if (existing) return existing;

  const db = this.config.known_databases[alias];
  if (!db) {
    throw new Error(`Unknown database alias "${alias}".`);
  }
  const account = this.getAccountConfig(alias, accountKey);
  const opts: PoolOptions = {
    host: db.host,
    port: db.port || 3306,
    user: account.user,
    password: account.password,
    database: physicalDatabase,
    connectTimeout: db.connect_timeout || 10000,
    waitForConnections: true,
    connectionLimit: 3,
    maxIdle: 1,
    idleTimeout: 60000,
    enableKeepAlive: true,
  };
  const pool = mysql.createPool(opts);
  this.pools.set(poolKey, pool);
  return pool;
}
```

- [ ] **Step 3: Update `executeQuery(...)` to use resolved targets and emit clear headers**

Replace the front of `executeQuery(...)` with:

```ts
const target = this.resolveQueryTarget(input);
const sql: string = input.sql;
const limit: number = Math.min(input.limit || 100, 1000);

if (!isReadOnlyQuery(sql)) {
  return "Error: Only read-only queries are allowed (SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, WITH). Write operations are blocked for safety.";
}

const accountKey = this.resolveAccountKey(target.alias, context);
const pool = this.getOrCreatePool(target.alias, accountKey, target.physicalDatabase);
const finalSql = this.applyLimit(sql, limit);
const timeoutMs = this.config.known_databases[target.alias].query_timeout || 30000;
```

and replace the header block with:

```ts
const header = [
  "## SQL Used (MUST include in your answer)",
  `instance: ${target.alias}`,
  `database: ${target.physicalDatabase}`,
  `mode: ${target.legacyMode ? "legacy" : "instance"}`,
  `sql: ${finalSql}`,
  `rows: ${rows.length}`,
  "",
  "When answering: (1) show this SQL in a code block, (2) explain what it does, (3) cross-verify with source code if relevant.",
  "",
  "## Data",
].join("\n");
```

- [ ] **Step 4: Update the `query` tool schema to expose `instance` and keep legacy compatibility**

In `src/index.ts`, change the `query` tool definition from requiring `database` to:

```ts
input_schema: {
  type: "object",
  properties: {
    instance: {
      type: "string",
      description: "Configured connection alias. Preferred for new callers.",
    },
    database: {
      type: "string",
      description: "Physical database/schema when used with `instance`; legacy callers may still send the alias here when `instance` is omitted.",
    },
    sql: {
      type: "string",
      description: "Read-only SQL query to execute.",
    },
    limit: {
      type: "number",
      description: "Maximum number of rows to return (default 100, max 1000).",
    },
  },
  required: ["sql"],
}
```

- [ ] **Step 5: Update the security test query call to the preferred input shape**

In `tests/security.test.ts`, change:

```ts
const result = await plugin.executeTool("query", {
  database: "mydb",
  sql: "SELECT * FROM users",
});
```

to:

```ts
const result = await plugin.executeTool("query", {
  instance: "mydb",
  database: "warehouse",
  sql: "SELECT * FROM users",
});
```

and add:

```ts
expect(result).toContain("instance: mydb");
expect(result).toContain("database: warehouse");
```

- [ ] **Step 6: Run the focused tests to verify query execution is green**

Run:

```bash
cd /home/felix021/.config/superpowers/worktrees/mysql-query/role-based-db-accounts
npm test -- tests/role-accounts.test.ts tests/security.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit the runtime execution changes**

```bash
git add src/index.ts tests/role-accounts.test.ts tests/security.test.ts
git commit -m "feat: route mysql queries by alias and runtime database"
```

### Task 5: Preserve Alias-Based Knowledge and Update Guidance

**Files:**
- Modify: `tests/knowledge-dir.test.ts`
- Modify: `knowledge/CLAUDE.md`
- Modify: `src/index.ts`
- Test: `tests/knowledge-dir.test.ts`

- [ ] **Step 1: Add an explicit alias-based knowledge test**

Extend `tests/knowledge-dir.test.ts` with:

```ts
it("keeps get_topic_knowledge alias-based after query contract changes", async () => {
  const topicDir = join(tmpDir, "doris");
  mkdirSync(topicDir, { recursive: true });
  writeFileSync(
    join(topicDir, "_catalog.md"),
    "---\ndescription: doris warehouse\n---\nCatalog for doris\n",
  );
  writeFileSync(
    join(topicDir, "schema.md"),
    "---\ntitle: Schema\ndescription: table schema reference\n---\nSchema details here\n",
  );

  const plugin = new MySQLQueryPlugin();
  plugin.name = "mysql-query";
  await plugin.init({ ...structuredClone(BASE_CONFIG), knowledge_dir: tmpDir });

  const out = await plugin.executeTool("get_topic_knowledge", {
    database: "doris",
    doc: "schema",
  });
  expect(out).toContain("Schema details here");
});
```

- [ ] **Step 2: Update knowledge authoring guidance**

In `knowledge/CLAUDE.md`, add under structure/guidance:

```md
- Knowledge directories remain keyed by configured alias, not by runtime physical database.
- If one alias can query multiple physical databases, document the default physical database and common alternatives in `_catalog.md`.
```

- [ ] **Step 3: Update tool descriptions to explain the contract split**

In `src/index.ts`, change the `query` tool description text to say:

```ts
"Use `instance` for the configured connection alias.",
"Use optional `database` for the physical target database/schema.",
"Legacy callers may still send `database=<alias>`, but new callers should prefer `instance + database`.",
```

and add one line to `get_topic_knowledge` description:

```ts
"For this tool, `database` still means the configured alias used by the knowledge directory.",
```

- [ ] **Step 4: Run the focused knowledge tests**

Run:

```bash
cd /home/felix021/.config/superpowers/worktrees/mysql-query/role-based-db-accounts
npm test -- tests/knowledge-dir.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit the knowledge-guidance updates**

```bash
git add tests/knowledge-dir.test.ts knowledge/CLAUDE.md src/index.ts
git commit -m "docs: explain alias-based mysql knowledge loading"
```

### Task 6: Update Public Docs and Verify End-to-End

**Files:**
- Modify: `config.example.yaml`
- Modify: `README.md`
- Modify: `README_EN.md`
- Test: `npm run preflight`

- [ ] **Step 1: Update the config example**

Change `config.example.yaml` to show optional default database and the role-based account structure:

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
      # complaint:
      #   user: "${MYSQL_COMPLAINT_USER}"
      #   password: "${MYSQL_COMPLAINT_PASSWORD}"
```

- [ ] **Step 2: Update both READMEs**

Document:

- config key is the alias
- config `database` is optional default physical database
- preferred query usage is `instance + optional database`
- legacy `database=<alias>` is still supported during the transition
- runtime comments exist in code intentionally because the compatibility path would otherwise be confusing

Include one example:

```json
{ "instance": "doris", "database": "wizard", "sql": "SELECT COUNT(*) FROM pay_users" }
```

and one legacy example:

```json
{ "database": "doris", "sql": "SELECT COUNT(*) FROM pay_users" }
```

- [ ] **Step 3: Run full preflight**

Run:

```bash
cd /home/felix021/.config/superpowers/worktrees/mysql-query/role-based-db-accounts
npm run preflight
```

Expected: PASS

- [ ] **Step 4: Check git status**

Run:

```bash
cd /home/felix021/.config/superpowers/worktrees/mysql-query/role-based-db-accounts
git status --short
```

Expected: clean working tree except for the intended doc changes before the final commit.

- [ ] **Step 5: Commit the docs and final cleanup**

```bash
git add config.example.yaml README.md README_EN.md
git commit -m "docs: describe instance-based mysql queries"
```

Only add `git add -A` and an extra cleanup commit if verification uncovers a real bug that required a code change after Step 3.

---

## Self-Review

- Spec coverage:
  - alias key remains config alias: Tasks 2, 3, 6
  - config `database` optional: Task 2
  - new `instance + database?` contract: Tasks 1, 3, 4, 6
  - legacy compatibility path: Tasks 1, 3, 4, 6
  - strict physical database validation: Tasks 1 and 3
  - pool isolation by resolved physical database: Task 4
  - knowledge remains alias-based: Task 5
  - explanatory comments required in code: Task 3
- Placeholder scan:
  - no TBD/TODO markers
  - every test step has concrete commands and expected outcomes
  - every code step names exact files and target snippets
- Type consistency:
  - uses `instance`, `database`, `resolved alias`, `physical database`, and `legacyMode` consistently across tasks

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-25-instance-alias-and-runtime-database-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
