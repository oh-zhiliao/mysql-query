# Role-Based DB Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `mysql-query` select different MySQL accounts by request `role`, so Feishu roles map to different database privileges without changing logical database aliases.

**Architecture:** Replace the per-database single-account model with a required `accounts` map under each database alias. Resolve the effective account at query time from `context.role`, build lazy pools per `database alias + account key`, and fail closed when a non-default Feishu role has no mapping. Knowledge loading, tool names, and user-facing database aliases remain unchanged.

**Tech Stack:** TypeScript, Vitest, mysql2/promise, zhiliao `ToolPlugin` type shim

---

## File Map

- Modify: `src/index.ts`
  - Replace legacy `DatabaseConfig` with base DB config + `accounts`
  - Add request-context-aware account resolution
  - Replace eager single-pool initialization with lazy per-account pool cache
  - Expand secret filtering to all configured accounts
- Modify: `types/plugin-core.d.ts`
  - Sync plugin type shim with core `executeTool(name, input, context?)`
  - Add optional request context shape needed by this plugin
- Modify: `config.example.yaml`
  - Remove legacy top-level `user/password`
  - Show required `accounts.default` and an example extra role
- Modify: `README.md`
  - Document new config structure, role behavior, and upgrade notes
- Modify: `README_EN.md`
  - Same as Chinese README
- Add: `tests/role-accounts.test.ts`
  - Focused tests for config validation, role routing, lazy pool reuse, and fail-closed behavior
- Modify: `tests/security.test.ts`
  - Update config fixtures to new `accounts` schema
  - Keep coverage for secret filtering and no-leak behavior
- Modify: `tests/knowledge-dir.test.ts`
  - Update config fixtures to new `accounts` schema

## Non-Goals

- No support for merging multiple roles
- No per-command role policy in this plugin beyond account selection
- No automatic rewriting of local deployment `config.yaml` files at runtime
- No role-specific knowledge directories

## Upgrade Strategy

This implementation does **not** keep runtime compatibility with legacy top-level `user/password`.

Upgrade is one-time and explicit:

```yaml
# before
known_databases:
  mydb:
    host: "127.0.0.1"
    port: 3306
    user: "${MYSQL_USER}"
    password: "${MYSQL_PASSWORD}"
    database: "warehouse"

# after
known_databases:
  mydb:
    host: "127.0.0.1"
    port: 3306
    database: "warehouse"
    accounts:
      default:
        user: "${MYSQL_USER}"
        password: "${MYSQL_PASSWORD}"
```

After this release, plugin init should reject any database entry that still uses legacy top-level `user/password`.

---

### Task 1: Update Type Contracts First

**Files:**
- Modify: `types/plugin-core.d.ts`
- Test: `npm run typecheck`

- [ ] **Step 1: Write the failing type-level expectation**

Add the request context types to the shim so the compiler has the target shape:

```ts
export interface RequestContext {
  channel?: "feishu" | "webchat";
  chatType?: "p2p" | "group";
  chatId?: string;
  userId: string;
  role?: string;
  logId: string;
}
```

and change:

```ts
executeTool(name: string, input: Record<string, any>): Promise<string>;
```

to:

```ts
executeTool(name: string, input: Record<string, any>, context?: RequestContext): Promise<string>;
```

- [ ] **Step 2: Run typecheck to verify the shim edit is accepted**

Run:

```bash
cd /home/felix021/.config/superpowers/worktrees/mysql-query/role-based-db-accounts
npm run typecheck
```

Expected: PASS. This is a type-contract synchronization step rather than a meaningful red phase, because TypeScript allows the implementation to omit an optional trailing parameter.

- [ ] **Step 3: Update the plugin signature minimally**

Update the import in `src/index.ts`:

```ts
import type { ToolPlugin, ToolDefinition, RequestContext } from "../../../src/agent/tool-plugin.js";
```

Change in `src/index.ts`:

```ts
async executeTool(name: string, input: Record<string, any>, context?: RequestContext): Promise<string> {
  switch (name) {
    case "query":
      return this.executeQuery(input, context);
    case "get_topic_knowledge":
      return this.getTopicKnowledge(input);
    default:
      return `Unknown tool: ${name}`;
  }
}
```

- [ ] **Step 4: Run typecheck to verify the signature change is green**

Run:

```bash
cd /home/felix021/.config/superpowers/worktrees/mysql-query/role-based-db-accounts
npm run typecheck
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add types/plugin-core.d.ts src/index.ts
git commit -m "refactor: add request context to mysql plugin interface"
```

### Task 2: Lock the New Config Shape with Tests

**Files:**
- Add: `tests/role-accounts.test.ts`
- Modify: `src/index.ts`
- Test: `tests/role-accounts.test.ts`

- [ ] **Step 1: Write failing config validation tests**

Create `tests/role-accounts.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("mysql2/promise", () => ({
  default: {
    createPool: vi.fn(() => ({
      query: vi.fn(),
      end: vi.fn(),
    })),
  },
}));

import MySQLQueryPlugin from "../src/index.js";

const NEW_CONFIG = {
  known_databases: {
    mydb: {
      host: "127.0.0.1",
      database: "warehouse",
      accounts: {
        default: { user: "readonly_user", password: "secret123" },
        finance_admin: { user: "finance_user", password: "finance_secret" },
      },
    },
  },
};

describe("role account config validation", () => {
  let plugin: MySQLQueryPlugin;

  beforeEach(() => {
    plugin = new MySQLQueryPlugin();
    plugin.name = "mysql-query";
  });

  it("accepts accounts.default config", async () => {
    await expect(plugin.init(structuredClone(NEW_CONFIG))).resolves.toBeUndefined();
  });

  it("rejects legacy top-level user/password config", async () => {
    await expect(plugin.init({
      known_databases: {
        mydb: {
          host: "127.0.0.1",
          database: "warehouse",
          user: "old_user",
          password: "old_password",
        },
      },
    })).rejects.toThrow(/accounts/i);
  });

  it("rejects configs that mix legacy user/password with accounts", async () => {
    await expect(plugin.init({
      known_databases: {
        mydb: {
          host: "127.0.0.1",
          database: "warehouse",
          user: "old_user",
          password: "old_password",
          accounts: {
            default: { user: "readonly_user", password: "secret123" },
          },
        },
      },
    })).rejects.toThrow(/legacy/i);
  });

  it("rejects accounts entries missing user or password", async () => {
    await expect(plugin.init({
      known_databases: {
        mydb: {
          host: "127.0.0.1",
          database: "warehouse",
          accounts: {
            default: { user: "readonly_user" },
          },
        },
      },
    })).rejects.toThrow(/default/i);
  });

  it("rejects unresolved account env vars", async () => {
    await expect(plugin.init({
      known_databases: {
        mydb: {
          host: "127.0.0.1",
          database: "warehouse",
          accounts: {
            default: { user: "${MYSQL_USER}", password: "${MYSQL_PASSWORD}" },
          },
        },
      },
    })).rejects.toThrow(/not resolved/i);
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
cd /home/felix021/.config/superpowers/worktrees/mysql-query/role-based-db-accounts
npm test -- tests/role-accounts.test.ts
```

Expected: FAIL because current plugin still expects top-level `user/password`.

- [ ] **Step 3: Implement the new config types and validation**

In `src/index.ts`, replace the old config types with:

```ts
interface AccountConfig {
  user: string;
  password: string;
}

interface DatabaseConfig {
  host: string;
  port?: number;
  database: string;
  connect_timeout?: number;
  query_timeout?: number;
  accounts: Record<string, AccountConfig>;
}
```

In `init(config)`:

```ts
for (const [name, db] of Object.entries(config.known_databases as Record<string, DatabaseConfig>)) {
  if (!db.host || !db.database) {
    throw new Error(`Database "${name}" missing required fields (host, database)`);
  }
  if ((db as any).user || (db as any).password) {
    throw new Error(`Database "${name}" still uses legacy top-level user/password. Migrate to accounts.default.`);
  }
  if (!db.accounts || Object.keys(db.accounts).length === 0) {
    throw new Error(`Database "${name}" must define accounts.default and any role-specific accounts`);
  }
  if (!db.accounts.default) {
    throw new Error(`Database "${name}" missing required accounts.default`);
  }
  for (const [accountKey, account] of Object.entries(db.accounts)) {
    if (!account.user || !account.password) {
      throw new Error(`Database "${name}" account "${accountKey}" missing required fields (user, password)`);
    }
    if (account.user.startsWith("${") || account.password.startsWith("${")) {
      throw new Error(`Database "${name}" account "${accountKey}": env var not resolved — check environment variables`);
    }
  }
}
```

- [ ] **Step 4: Re-run the focused test**

Run:

```bash
cd /home/felix021/.config/superpowers/worktrees/mysql-query/role-based-db-accounts
npm test -- tests/role-accounts.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/role-accounts.test.ts
git commit -m "feat: require role-scoped account config"
```

### Task 3: Implement Role-to-Account Resolution

**Files:**
- Modify: `src/index.ts`
- Test: `tests/role-accounts.test.ts`

- [ ] **Step 1: Add failing account resolution tests**

Extend `tests/role-accounts.test.ts` with:

```ts
it("uses the exact matching Feishu role account", async () => {
  await plugin.init(structuredClone(NEW_CONFIG));
  expect((plugin as any).resolveAccountKey("mydb", {
    channel: "feishu",
    userId: "ou_admin",
    role: "finance_admin",
    logId: "log1",
  })).toBe("finance_admin");
});

it("uses default when role is absent", async () => {
  await plugin.init(structuredClone(NEW_CONFIG));
  expect((plugin as any).resolveAccountKey("mydb", {
    channel: "webchat",
    userId: "u1",
    logId: "log1",
  })).toBe("default");
});

it("denies unmapped non-default Feishu roles", async () => {
  await plugin.init(structuredClone(NEW_CONFIG));
  expect(() => (plugin as any).resolveAccountKey("mydb", {
    channel: "feishu",
    userId: "ou_admin",
    role: "analyst",
    logId: "log1",
  })).toThrow(/not configured/i);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
cd /home/felix021/.config/superpowers/worktrees/mysql-query/role-based-db-accounts
npm test -- tests/role-accounts.test.ts
```

Expected: FAIL because `resolveAccountKey` does not exist.

- [ ] **Step 3: Implement minimal resolution helpers**

Add to `src/index.ts`:

```ts
private resolveAccountKey(dbName: string, context?: RequestContext): string {
  const db = this.config.known_databases[dbName];
  if (!db) {
    throw new Error(`Unknown database "${dbName}"`);
  }

  const role = context?.role;
  if (!role) {
    return "default";
  }

  if (db.accounts[role]) {
    return role;
  }

  throw new Error(`Access denied: role ${role} is not configured for database ${dbName}.`);
}

private getAccountConfig(dbName: string, accountKey: string): AccountConfig {
  const db = this.config.known_databases[dbName];
  const account = db?.accounts[accountKey];
  if (!account) {
    throw new Error(`Access denied: role ${accountKey} is not configured for database ${dbName}.`);
  }
  return account;
}
```

Design note for implementation: do **not** branch on `context.channel === "feishu"`. If `context.role` exists, treat it as authoritative regardless of channel string. This avoids a magic-literal channel dependency.

- [ ] **Step 4: Re-run the focused test**

Run:

```bash
cd /home/felix021/.config/superpowers/worktrees/mysql-query/role-based-db-accounts
npm test -- tests/role-accounts.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/role-accounts.test.ts
git commit -m "feat: resolve mysql accounts from request role"
```

### Task 4: Replace Single Pools with Lazy Per-Account Pools

**Files:**
- Modify: `src/index.ts`
- Test: `tests/role-accounts.test.ts`

- [ ] **Step 1: Add failing lazy pool tests**

Extend `tests/role-accounts.test.ts`:

```ts
import mysql from "mysql2/promise";

it("creates separate pools per database alias and account key", async () => {
  const createPool = vi.mocked(mysql.createPool);
  createPool.mockClear();
  await plugin.init(structuredClone(NEW_CONFIG));

  (plugin as any).getOrCreatePool("mydb", "default");
  (plugin as any).getOrCreatePool("mydb", "finance_admin");
  (plugin as any).getOrCreatePool("mydb", "default");

  expect(createPool).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
cd /home/felix021/.config/superpowers/worktrees/mysql-query/role-based-db-accounts
npm test -- tests/role-accounts.test.ts
```

Expected: FAIL because `initPools()` eagerly creates one pool per DB and `getOrCreatePool()` does not exist.

- [ ] **Step 3: Replace eager pool init with lazy pool cache**

In `src/index.ts`:

```ts
private pools = new Map<string, Pool>();
```

Add helper:

```ts
private buildPoolKey(dbName: string, accountKey: string): string {
  return `${dbName}\u0000${accountKey}`;
}

private getOrCreatePool(dbName: string, accountKey: string): Pool {
  const key = this.buildPoolKey(dbName, accountKey);
  const existing = this.pools.get(key);
  if (existing) {
    return existing;
  }

  const db = this.config.known_databases[dbName];
  const account = this.getAccountConfig(dbName, accountKey);
  const pool = mysql.createPool({
    host: db.host,
    port: db.port || 3306,
    user: account.user,
    password: account.password,
    database: db.database,
    connectTimeout: db.connect_timeout || 10000,
    waitForConnections: true,
    connectionLimit: 3,
    maxIdle: 1,
    idleTimeout: 60000,
    enableKeepAlive: true,
  });
  this.pools.set(key, pool);
  return pool;
}
```

Remove `initPools()` call from `init()` and delete the old eager method.

- [ ] **Step 4: Re-run the focused test**

Run:

```bash
cd /home/felix021/.config/superpowers/worktrees/mysql-query/role-based-db-accounts
npm test -- tests/role-accounts.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/role-accounts.test.ts
git commit -m "refactor: create mysql pools lazily per role account"
```

### Task 5: Wire Query Execution to Resolved Accounts

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/security.test.ts`
- Test: `tests/role-accounts.test.ts`

- [ ] **Step 1: Add failing query-path tests**

Extend `tests/role-accounts.test.ts`:

```ts
it("creates separate pools for default and role-specific accounts", async () => {
  const defaultOut = await plugin.executeTool("query", {
    database: "mydb",
    sql: "SELECT 1",
  });

  const financeOut = await plugin.executeTool("query", {
    database: "mydb",
    sql: "SELECT 1",
  }, {
    channel: "feishu",
    userId: "ou_admin",
    role: "finance_admin",
    logId: "log1",
  });

  expect(createPoolMock).toHaveBeenCalledTimes(2);
  expect(defaultOut).toContain("readonly_user");
  expect(financeOut).toContain("finance_user");
});

it("returns an access-denied error for unmapped roles without leaking DB credentials", async () => {
  await plugin.init(structuredClone(NEW_CONFIG));

  const out = await plugin.executeTool("query", {
    database: "mydb",
    sql: "SELECT 1",
  }, {
    channel: "feishu",
    userId: "ou_admin",
    role: "analyst",
    logId: "log1",
  });

  expect(out).toMatch(/Access denied/i);
  expect(out).not.toContain("finance_user");
  expect(out).not.toContain("127.0.0.1");
});

it("uses the default account when request context is omitted entirely", async () => {
  const out = await plugin.executeTool("query", {
    database: "mydb",
    sql: "SELECT 1",
  });

  expect(createPoolMock).toHaveBeenCalledWith(expect.objectContaining({
    user: "readonly_user",
  }));
  expect(out).toContain("readonly_user");
});

it("rejects prototype-chain role names", () => {
  expect(() => (plugin as any).resolveAccountKey("mydb", {
    channel: "feishu",
    userId: "ou_admin",
    role: "__proto__",
    logId: "log1",
  })).toThrow(/not configured/i);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
cd /home/felix021/.config/superpowers/worktrees/mysql-query/role-based-db-accounts
npm test -- tests/role-accounts.test.ts
```

Expected: FAIL because `executeQuery()` still uses `this.pools.get(dbName)`.

- [ ] **Step 3: Implement context-aware query execution**

Change `executeQuery`:

```ts
private async executeQuery(input: Record<string, any>, context?: RequestContext): Promise<string> {
  try {
    const dbName: string = input.database;
    const sql: string = input.sql;
    const limit: number = Math.min(input.limit || 100, 1000);

    if (!this.config.known_databases[dbName]) {
      const available = Object.keys(this.config.known_databases).join(", ");
      return `Unknown database "${dbName}". Available: ${available}`;
    }

    if (!isReadOnlyQuery(sql)) {
      return "Error: Only read-only queries are allowed (SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, WITH). Write operations are blocked for safety.";
    }

    const finalSql = this.applyLimit(sql, limit);
    const accountKey = this.resolveAccountKey(dbName, context);
    const pool = this.getOrCreatePool(dbName, accountKey);
    const timeoutMs = this.config.known_databases[dbName].query_timeout || 30000;
    const [rows, fields] = await pool.query({ sql: finalSql, timeout: timeoutMs });
    // keep existing result rendering
  } catch (err: any) {
    return `Error in ${this.name}.query: ${err.message}`;
  }
}
```

- [ ] **Step 4: Update security fixtures to the new config shape**

In `tests/security.test.ts`, convert:

```ts
mydb: {
  host: "10.0.0.1",
  port: 9030,
  user: "admin",
  password: "secret123",
  database: "warehouse",
}
```

to:

```ts
mydb: {
  host: "10.0.0.1",
  port: 9030,
  database: "warehouse",
  accounts: {
    default: {
      user: "admin",
      password: "secret123",
    },
  },
}
```

and do the same for `secondary`.

Also extend the secret-pattern expectations so every configured account username and password is covered.

- [ ] **Step 5: Re-run focused tests**

Run:

```bash
cd /home/felix021/.config/superpowers/worktrees/mysql-query/role-based-db-accounts
npm test -- tests/role-accounts.test.ts tests/security.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts tests/role-accounts.test.ts tests/security.test.ts
git commit -m "feat: route mysql queries by request role"
```

### Task 6: Expand Secret Filtering and Knowledge Test Fixtures

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/security.test.ts`
- Modify: `tests/knowledge-dir.test.ts`
- Test: `tests/security.test.ts tests/knowledge-dir.test.ts`

- [ ] **Step 1: Write or extend failing tests for all-account secrets**

In `tests/security.test.ts`, assert that all account credentials are covered:

```ts
it("matches every configured account username and password", () => {
  const patterns = plugin.getSecretPatterns();
  expect(patterns.some((p) => p.test("readonly_user"))).toBe(true);
  expect(patterns.some((p) => p.test("finance_user"))).toBe(true);
  expect(patterns.some((p) => p.test("secret123"))).toBe(true);
  expect(patterns.some((p) => p.test("finance_secret"))).toBe(true);
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
cd /home/felix021/.config/superpowers/worktrees/mysql-query/role-based-db-accounts
npm test -- tests/security.test.ts tests/knowledge-dir.test.ts
```

Expected: FAIL because `getSecretPatterns()` still scans only the old top-level fields.

- [ ] **Step 3: Implement all-account secret pattern collection**

Replace `getSecretPatterns()` with:

```ts
getSecretPatterns(): RegExp[] {
  const patterns: RegExp[] = [];
  for (const db of Object.values(this.config.known_databases)) {
    patterns.push(new RegExp(escapeRegex(db.host), "g"));
    for (const account of Object.values(db.accounts)) {
      patterns.push(new RegExp(escapeRegex(account.user), "g"));
      patterns.push(new RegExp(escapeRegex(account.password), "g"));
    }
  }
  return patterns;
}
```

- [ ] **Step 4: Update `tests/knowledge-dir.test.ts` fixtures**

Replace its base config to the new shape:

```ts
const BASE_CONFIG = {
  known_databases: {
    mydb: {
      host: "127.0.0.1",
      database: "warehouse",
      accounts: {
        default: {
          user: "readonly_user",
          password: "secret123",
        },
      },
    },
  },
};
```

- [ ] **Step 5: Re-run focused tests**

Run:

```bash
cd /home/felix021/.config/superpowers/worktrees/mysql-query/role-based-db-accounts
npm test -- tests/security.test.ts tests/knowledge-dir.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/index.ts tests/security.test.ts tests/knowledge-dir.test.ts
git commit -m "fix: cover all mysql role-account secrets"
```

### Task 7: Update Examples and Upgrade Docs

**Files:**
- Modify: `config.example.yaml`
- Modify: `README.md`
- Modify: `README_EN.md`
- Test: `npm run typecheck`

- [ ] **Step 1: Write the doc/config changes**

Update `config.example.yaml` to:

```yaml
known_databases:
  my_app:
    host: "127.0.0.1"
    port: 3306
    database: "my_app_db"
    accounts:
      default:
        user: "${MYSQL_DEFAULT_USER}"
        password: "${MYSQL_DEFAULT_PASSWORD}"
      analyst:
        user: "${MYSQL_ANALYST_USER}"
        password: "${MYSQL_ANALYST_PASSWORD}"
```

In `README.md` and `README_EN.md`, document:

- the new `accounts.default` structure
- that `role` selects the account
- that unmapped non-default roles fail closed
- the one-time upgrade path from old `user/password` to `accounts.default`
- that plugin code and `config.yaml` must be deployed atomically during the upgrade, because legacy config is rejected at startup

- [ ] **Step 2: Run typecheck as a cheap validation gate**

Run:

```bash
cd /home/felix021/.config/superpowers/worktrees/mysql-query/role-based-db-accounts
npm run typecheck
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add config.example.yaml README.md README_EN.md
git commit -m "docs: describe role-based mysql accounts"
```

### Task 8: Full Verification

**Files:**
- Test only

- [ ] **Step 1: Run the full plugin preflight**

Run:

```bash
cd /home/felix021/.config/superpowers/worktrees/mysql-query/role-based-db-accounts
npm run preflight
```

Expected: PASS with lint, typecheck, and all Vitest suites green.

- [ ] **Step 2: Sanity-check git status**

Run:

```bash
cd /home/felix021/.config/superpowers/worktrees/mysql-query/role-based-db-accounts
git status --short
```

Expected: clean working tree

- [ ] **Step 3: Commit any final fixups if needed**

```bash
git add -A
git commit -m "chore: finalize role-based mysql account routing"
```

Only do this if verification required a real fix. If the tree is already clean, skip.

---

## Self-Review

- Spec coverage:
  - role-aware account selection: Tasks 3–5
  - remove legacy runtime compatibility: Task 2 + Task 7
  - fail-closed unmapped roles: Tasks 3 and 5
  - no credential leakage: Tasks 5 and 6
  - plugin type sync with core request context: Task 1
  - rollout docs for one-time migration: Task 7
- Placeholder scan:
  - no TODO/TBD markers
  - every test step has concrete commands
  - every code step names exact files and snippets
- Type consistency:
  - uses `RequestContext`, `accounts.default`, `resolveAccountKey`, `getOrCreatePool` consistently across tasks

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-14-role-based-db-accounts-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
