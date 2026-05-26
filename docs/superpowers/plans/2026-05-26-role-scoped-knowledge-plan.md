# Role-Scoped Knowledge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `mysql-query` knowledge and alias visibility role-aware, add explicit `/mysql-query reload-knowledge`, and close knowledge leakage through both tool metadata and system prompt paths.

**Architecture:** First extend zhiliao core so tool metadata and plugin commands are request-aware (`RequestContext` for tool definitions/system prompt, `isAdmin` for plugin commands). Then refactor `mysql-query` to build a startup-time knowledge snapshot keyed by `alias + scope`, filter it per request, expose only role-visible aliases, and support atomic reload through an admin-only plugin command.

**Tech Stack:** TypeScript, Vitest, zhiliao agent plugin interfaces, mysql-query plugin, markdown knowledge tree

---

## File Structure

### zhiliao core (`/home/felix021/code/zhiliao/zhiliao/agent`)

- Modify: `src/agent/tool-plugin.ts`
  - Make tool metadata APIs request-aware and add `isAdmin` to `CommandCallContext`
- Modify: `src/agent/tool-registry.ts`
  - Thread request context into tool definitions and system prompt addendum
- Modify: `src/agent/invoker.ts`
  - Build request-scoped tool definitions and request-scoped system prompt addendum
- Modify: `src/channels/channel-router.ts`
  - Pass `isAdmin: false` for webchat plugin commands
- Modify: `src/channels/feishu/adapter.ts`
  - Pass `isAdmin` into plugin command context
- Modify: `tests/agent/tool-registry.test.ts`
  - Cover request-aware metadata and `isAdmin`
- Modify: `tests/agent/invoker.test.ts`
  - Cover request-aware tool definitions/system prompt use
- Modify: `tests/channels/feishu/adapter.test.ts`
  - Cover plugin command `isAdmin`
- Modify: `tests/channels/channel-router.test.ts`
  - Cover webchat command context shape

### mysql-query (`/home/felix021/code/zhiliao/mysql-query`)

- Modify: `src/index.ts`
  - Add knowledge snapshot structure, request-aware metadata, role-aware `get_topic_knowledge`, and reload command
- Modify: `types/plugin-core.d.ts`
  - Sync with core interface changes
- Create: `tests/role-knowledge.test.ts`
  - Focused TDD for role-scoped knowledge visibility, logs, and reload behavior
- Modify: `tests/role-accounts.test.ts`
  - Extend to cover request-aware tool descriptions and hidden aliases
- Modify: `README.md`
- Modify: `README_EN.md`
- Modify: `knowledge/CLAUDE.md`
- Modify: `config.example.yaml`

---

### Task 1: Make zhiliao Tool Metadata Request-Aware

**Files:**
- Modify: `/home/felix021/code/zhiliao/zhiliao/agent/src/agent/tool-plugin.ts`
- Modify: `/home/felix021/code/zhiliao/zhiliao/agent/src/agent/tool-registry.ts`
- Modify: `/home/felix021/code/zhiliao/zhiliao/agent/src/agent/invoker.ts`
- Test: `/home/felix021/code/zhiliao/zhiliao/agent/tests/agent/tool-registry.test.ts`
- Test: `/home/felix021/code/zhiliao/zhiliao/agent/tests/agent/invoker.test.ts`

- [ ] **Step 1: Write the failing registry test for request-aware metadata**

```ts
it("passes RequestContext into tool definitions and system prompt addendum", () => {
  const p = makePlugin("mysql-query");
  p.getToolDefinitions = vi.fn((ctx?: RequestContext) => [
    { name: `query-${ctx?.role ?? "none"}`, description: "d", input_schema: {} },
  ]);
  p.getSystemPromptAddendum = vi.fn((ctx?: RequestContext) => `role=${ctx?.role ?? "none"}`);

  registry.register(p);

  const defs = registry.getToolDefinitions({ userId: "u1", role: "complaint", logId: "log1" });
  const addendum = registry.getSystemPromptAddendum({ userId: "u1", role: "complaint", logId: "log1" });

  expect(defs[0].name).toBe("mysql-query.query-complaint");
  expect(addendum).toContain("role=complaint");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd /home/felix021/code/zhiliao/zhiliao/agent
npm test -- tests/agent/tool-registry.test.ts
```

Expected: FAIL because `getToolDefinitions()` and `getSystemPromptAddendum()` do not accept context yet.

- [ ] **Step 3: Write the failing invoker test for request-scoped metadata**

```ts
it("builds tool definitions and system prompt addendum with request context", async () => {
  const requestContext = { channel: "feishu" as const, userId: "ou_u1", role: "complaint", logId: "log1" };
  const getToolDefinitions = vi.fn(() => [{ name: "mysql-query.query", description: "role-specific", input_schema: {} }]);
  const getSystemPromptAddendum = vi.fn(() => "role-specific addendum");
  mockToolRegistry.getToolDefinitions = getToolDefinitions;
  mockToolRegistry.getSystemPromptAddendum = getSystemPromptAddendum;

  await agent.ask("hello", "session-ctx-meta", undefined, requestContext);

  expect(getToolDefinitions).toHaveBeenCalledWith(requestContext);
  expect(getSystemPromptAddendum).toHaveBeenCalledWith(requestContext);
});
```

- [ ] **Step 4: Run test to verify it fails**

Run:

```bash
cd /home/felix021/code/zhiliao/zhiliao/agent
npm test -- tests/agent/invoker.test.ts
```

Expected: FAIL because invoker currently calls request-agnostic registry methods.

- [ ] **Step 5: Implement the minimal core interface change**

```ts
// src/agent/tool-plugin.ts
getToolDefinitions(context?: RequestContext): ToolDefinition[];
getSystemPromptAddendum?(context?: RequestContext): string;

export interface CommandCallContext {
  userId: string;
  chatType: "p2p" | "group";
  chatId: string;
  logId: string;
  channel?: "feishu" | "webchat";
  role?: string;
  isAdmin: boolean;
}
```

```ts
// src/agent/tool-registry.ts
getToolDefinitions(context?: RequestContext): ToolDefinition[] {
  const allDefs: ToolDefinition[] = [];
  for (const [name, plugin] of this.plugins) {
    const prefix = name === BUILTIN_PLUGIN_NAME ? "" : `${name}.`;
    for (const def of plugin.getToolDefinitions(context)) {
      allDefs.push({ ...def, name: `${prefix}${def.name}` });
    }
  }
  return allDefs;
}

getSystemPromptAddendum(context?: RequestContext): string {
  const parts: string[] = [];
  for (const plugin of this.plugins.values()) {
    const addendum = plugin.getSystemPromptAddendum?.(context);
    if (addendum) parts.push(addendum);
  }
  return parts.join("\n\n");
}
```

```ts
// src/agent/invoker.ts
const toolDefs = this.tools?.getToolDefinitions(requestContext) ?? [];
const addendum = this.tools?.getSystemPromptAddendum(requestContext) ?? "";
```

- [ ] **Step 6: Run focused agent tests**

Run:

```bash
cd /home/felix021/code/zhiliao/zhiliao/agent
npm test -- tests/agent/tool-registry.test.ts tests/agent/invoker.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/felix021/code/zhiliao/zhiliao
git add agent/src/agent/tool-plugin.ts agent/src/agent/tool-registry.ts agent/src/agent/invoker.ts agent/tests/agent/tool-registry.test.ts agent/tests/agent/invoker.test.ts
git commit -m "feat: make tool metadata request-aware"
```

---

### Task 2: Thread `isAdmin` Into Plugin Command Context

**Files:**
- Modify: `/home/felix021/code/zhiliao/zhiliao/agent/src/channels/channel-router.ts`
- Modify: `/home/felix021/code/zhiliao/zhiliao/agent/src/channels/feishu/adapter.ts`
- Test: `/home/felix021/code/zhiliao/zhiliao/agent/tests/channels/channel-router.test.ts`
- Test: `/home/felix021/code/zhiliao/zhiliao/agent/tests/channels/feishu/adapter.test.ts`

- [ ] **Step 1: Write the failing webchat command-context test**

```ts
expect(mockRegistry.handleCommand).toHaveBeenCalledWith(
  "mysql-query",
  "reload-knowledge",
  [],
  expect.objectContaining({ isAdmin: false, channel: "webchat" })
);
```

- [ ] **Step 2: Write the failing feishu command-context test**

```ts
expect(mockToolRegistry.handleCommand).toHaveBeenCalledWith(
  "repo",
  "list",
  [],
  expect.objectContaining({ userId: "ou_admin", isAdmin: true, role: "default" })
);
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
cd /home/felix021/code/zhiliao/zhiliao/agent
npm test -- tests/channels/channel-router.test.ts tests/channels/feishu/adapter.test.ts
```

Expected: FAIL because `isAdmin` is not present in command context.

- [ ] **Step 4: Implement minimal command context plumbing**

```ts
// src/channels/channel-router.ts
const callCtx = {
  userId: context.userId,
  chatType: "p2p" as const,
  chatId: context.channelName,
  logId: context.messageId ?? "",
  channel: "webchat" as const,
  role: context.requestContext?.role,
  isAdmin: false,
};
```

```ts
// src/channels/feishu/adapter.ts
private buildCommandContext(ctx: FeishuMessageContext, role: string): CommandCallContext {
  return {
    ...this.buildRequestContext(ctx, role),
    userId: ctx.senderId,
    chatType: ctx.chatType,
    chatId: ctx.chatId,
    logId: ctx.logId,
    isAdmin: this.isAdmin(ctx.senderId),
  };
}
```

- [ ] **Step 5: Run focused channel tests**

Run:

```bash
cd /home/felix021/code/zhiliao/zhiliao/agent
npm test -- tests/channels/channel-router.test.ts tests/channels/feishu/adapter.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/felix021/code/zhiliao/zhiliao
git add agent/src/channels/channel-router.ts agent/src/channels/feishu/adapter.ts agent/tests/channels/channel-router.test.ts agent/tests/channels/feishu/adapter.test.ts
git commit -m "feat: expose admin flag to plugin commands"
```

---

### Task 3: Add Role-Scoped Knowledge Snapshot and Request-Aware Metadata to mysql-query

**Files:**
- Modify: `/home/felix021/code/zhiliao/mysql-query/src/index.ts`
- Modify: `/home/felix021/code/zhiliao/mysql-query/types/plugin-core.d.ts`
- Create: `/home/felix021/code/zhiliao/mysql-query/tests/role-knowledge.test.ts`
- Modify: `/home/felix021/code/zhiliao/mysql-query/tests/role-accounts.test.ts`

- [ ] **Step 1: Write the failing role-knowledge test for alias visibility and prompt isolation**

```ts
it("only exposes aliases and catalog content visible to the current role", async () => {
  const plugin = await initPluginWithKnowledge({
    allow_common_knowledge: false,
    known_databases: {
      doris: {
        host: "127.0.0.1",
        database: "wizard",
        accounts: {
          default: { user: "readonly", password: "secret1" },
          complaint: { user: "complaint", password: "secret2" },
        },
      },
      finance: {
        host: "127.0.0.1",
        database: "ledger",
        accounts: {
          default: { user: "finance_default", password: "secret3" },
        },
      },
    },
    knowledgeTree: {
      doris: {
        roles: {
          complaint: {
            catalog: "---\ndescription: complaint doris\n---\n## Tables\n- `tickets`",
            docs: { "complaint-runbook.md": "---\ntitle: Complaint\n---\nUse wizard" },
          },
        },
      },
      finance: {
        roles: {
          default: {
            catalog: "---\ndescription: finance only\n---\n## Tables\n- `ledger`",
            docs: { "close-books.md": "---\ntitle: Close\n---\n" },
          },
        },
      },
    },
  });

  const defs = plugin.getToolDefinitions({ userId: "ou1", role: "complaint", logId: "log1" });
  const addendum = plugin.getSystemPromptAddendum?.({ userId: "ou1", role: "complaint", logId: "log1" }) ?? "";

  expect(JSON.stringify(defs)).toContain("doris");
  expect(JSON.stringify(defs)).not.toContain("finance");
  expect(addendum).toContain("tickets");
  expect(addendum).not.toContain("ledger");
});
```

- [ ] **Step 2: Write the failing test for `get_topic_knowledge` denial and missing logs**

```ts
it("denies docs outside the visible role scope and logs why knowledge is missing", async () => {
  const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const plugin = await initPluginWithKnowledge({
    allow_common_knowledge: false,
    known_databases: {
      doris: {
        host: "127.0.0.1",
        database: "wizard",
        accounts: { complaint: { user: "complaint", password: "secret2" }, default: { user: "readonly", password: "secret1" } },
      },
    },
    knowledgeTree: {
      doris: { common: { catalog: "---\ndescription: common\n---", docs: { "shared.md": "---\ntitle: Shared\n---" } } },
    },
  });

  const result = await plugin.executeTool("get_topic_knowledge", { database: "doris", doc: "shared" }, {
    userId: "ou1",
    role: "complaint",
    logId: "log1",
  });

  expect(result).toMatch(/No knowledge document is available/i);
  expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("knowledge denied"));
  expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("common_disabled"));
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
cd /home/felix021/code/zhiliao/mysql-query
npm test -- tests/role-knowledge.test.ts tests/role-accounts.test.ts
```

Expected: FAIL because current plugin uses startup-global knowledge and request-agnostic metadata.

- [ ] **Step 4: Implement the role-scoped knowledge snapshot**

```ts
interface KnowledgeScope {
  description: string;
  catalogBody: string;
  docs: Map<string, TopicDocMeta>;
}

interface AliasKnowledgeSnapshot {
  roleScopes: Map<string, KnowledgeScope>;
  commonScope?: KnowledgeScope;
}

private knowledgeByAlias = new Map<string, AliasKnowledgeSnapshot>();

private loadKnowledgeSnapshot(): Map<string, AliasKnowledgeSnapshot> {
  const snapshot = new Map<string, AliasKnowledgeSnapshot>();
  // Read knowledge/<alias>/roles/<role>/_catalog.md and optional common/_catalog.md
  // Build only in-memory scopes; do not inject deprecated top-level catalog content.
  return snapshot;
}
```

```ts
private resolveVisibleKnowledge(alias: string, context?: RequestContext) {
  const role = context?.role ?? "default";
  const aliasKnowledge = this.knowledgeByAlias.get(alias);
  const roleScope = aliasKnowledge?.roleScopes.get(role);
  const commonScope = this.config.allow_common_knowledge ? aliasKnowledge?.commonScope : undefined;
  return { role, roleScope, commonScope };
}
```

- [ ] **Step 5: Implement request-aware metadata and prompt building**

```ts
getToolDefinitions(context?: RequestContext): ToolDefinition[] {
  const visibleAliases = this.getVisibleAliases(context);
  const dbList = visibleAliases.map((alias) => {
    const { roleScope, commonScope } = this.resolveVisibleKnowledge(alias, context);
    const description = roleScope?.description || commonScope?.description || "configured database alias";
    return `  - "${alias}" — ${description}`;
  }).join("\n");
  // return query + get_topic_knowledge definitions
}

getSystemPromptAddendum(context?: RequestContext): string {
  const visibleAliases = this.getVisibleAliases(context);
  const lines = ["## MySQL Query Plugin", "", "### Known Databases"];
  for (const alias of visibleAliases) {
    const { roleScope, commonScope } = this.resolveVisibleKnowledge(alias, context);
    if (roleScope?.catalogBody) lines.push("", `**${alias}**`, roleScope.catalogBody);
    if (commonScope?.catalogBody) lines.push("", `**${alias} (common)**`, commonScope.catalogBody);
  }
  return lines.join("\n");
}
```

- [ ] **Step 6: Make `get_topic_knowledge` request-aware**

```ts
private getTopicKnowledge(input: Record<string, any>, context?: RequestContext): string {
  const alias = input.database;
  const doc = input.doc;
  const { role, roleScope, commonScope } = this.resolveVisibleKnowledge(alias, context);
  const roleDoc = roleScope?.docs.get(doc);
  const commonDoc = commonScope?.docs.get(doc);
  const docMeta = roleDoc || commonDoc;
  if (!docMeta) {
    console.log(`[mysql-query] knowledge denied: role=${role} alias=${alias} doc=${doc} allowCommon=${this.config.allow_common_knowledge ? "true" : "false"}`);
    return `No knowledge document is available for alias "${alias}" under role "${role}".`;
  }
  return readFileSync(docMeta.filePath, "utf-8");
}
```

- [ ] **Step 7: Update standalone type shim**

```ts
// types/plugin-core.d.ts
getToolDefinitions(context?: RequestContext): ToolDefinition[];
getSystemPromptAddendum?(context?: RequestContext): string;

export interface CommandCallContext {
  userId: string;
  chatType: "p2p" | "group";
  chatId: string;
  logId: string;
  channel?: "feishu" | "webchat";
  role?: string;
  isAdmin: boolean;
}
```

- [ ] **Step 8: Run focused plugin tests**

Run:

```bash
cd /home/felix021/code/zhiliao/mysql-query
npm test -- tests/role-knowledge.test.ts tests/role-accounts.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
cd /home/felix021/code/zhiliao/mysql-query
git add src/index.ts types/plugin-core.d.ts tests/role-knowledge.test.ts tests/role-accounts.test.ts
git commit -m "feat: add role-scoped mysql knowledge"
```

---

### Task 4: Add Admin-Only `/mysql-query reload-knowledge`

**Files:**
- Modify: `/home/felix021/code/zhiliao/mysql-query/src/index.ts`
- Modify: `/home/felix021/code/zhiliao/mysql-query/tests/role-knowledge.test.ts`

- [ ] **Step 1: Write the failing reload command test**

```ts
it("reloads knowledge only for admins and preserves the old snapshot on failure", async () => {
  const plugin = await initPluginWithKnowledge(/* valid initial tree */);
  const handlers = plugin.getCommandHandlers?.();

  const denied = await handlers!.subcommands["reload-knowledge"].handle([], {
    userId: "ou_user",
    chatType: "p2p",
    chatId: "oc1",
    logId: "log-denied",
    channel: "feishu",
    role: "complaint",
    isAdmin: false,
  });
  expect(denied).toMatch(/only admins/i);

  writeBrokenKnowledgeTree();
  const failed = await handlers!.subcommands["reload-knowledge"].handle([], {
    userId: "ou_admin",
    chatType: "p2p",
    chatId: "oc1",
    logId: "log-admin",
    channel: "feishu",
    role: "complaint",
    isAdmin: true,
  });
  expect(failed).toMatch(/failed/i);
  expect(plugin.getSystemPromptAddendum?.({ userId: "ou1", role: "complaint", logId: "log1" })).toContain("old catalog body");
});
```

- [ ] **Step 2: Run the reload test to verify it fails**

Run:

```bash
cd /home/felix021/code/zhiliao/mysql-query
npm test -- tests/role-knowledge.test.ts
```

Expected: FAIL because plugin has no command handlers and no atomic reload path.

- [ ] **Step 3: Implement atomic reload**

```ts
private swapKnowledgeSnapshot(next: Map<string, AliasKnowledgeSnapshot>): void {
  this.knowledgeByAlias = next;
}

private reloadKnowledge(): { aliases: number; roleScopes: number; commonScopes: number } {
  const next = this.loadKnowledgeSnapshot();
  const stats = this.countKnowledgeScopes(next);
  this.swapKnowledgeSnapshot(next);
  return stats;
}
```

```ts
getCommandHandlers(): PluginCommandHandler {
  return {
    subcommands: {
      "reload-knowledge": {
        description: "Reload role-scoped knowledge from disk",
        handle: async (_args, context) => {
          if (!context.isAdmin) return "Only admins can run /mysql-query reload-knowledge.";
          console.log(`[mysql-query] knowledge reload started: by=${context.userId}`);
          try {
            const stats = this.reloadKnowledge();
            console.log(`[mysql-query] knowledge reload finished: aliases=${stats.aliases} roleScopes=${stats.roleScopes} commonScopes=${stats.commonScopes}`);
            return `Knowledge reloaded: aliases=${stats.aliases}, role_scopes=${stats.roleScopes}, common_scopes=${stats.commonScopes}`;
          } catch (err: any) {
            console.log(`[mysql-query] knowledge reload failed: by=${context.userId} error=${err.message}`);
            return `Knowledge reload failed: ${err.message}`;
          }
        },
      },
    },
  };
}
```

- [ ] **Step 4: Run reload-focused tests**

Run:

```bash
cd /home/felix021/code/zhiliao/mysql-query
npm test -- tests/role-knowledge.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/felix021/code/zhiliao/mysql-query
git add src/index.ts tests/role-knowledge.test.ts
git commit -m "feat: add mysql knowledge reload command"
```

---

### Task 5: Update Documentation and Run Final Verification

**Files:**
- Modify: `/home/felix021/code/zhiliao/mysql-query/README.md`
- Modify: `/home/felix021/code/zhiliao/mysql-query/README_EN.md`
- Modify: `/home/felix021/code/zhiliao/mysql-query/knowledge/CLAUDE.md`
- Modify: `/home/felix021/code/zhiliao/mysql-query/config.example.yaml`

- [ ] **Step 1: Update config and README examples**

```yaml
# config.example.yaml
allow_common_knowledge: false

known_databases:
  doris:
    host: "127.0.0.1"
    database: "wizard"
    accounts:
      default:
        user: "${MYSQL_USER}"
        password: "${MYSQL_PASSWORD}"
      complaint:
        user: "${MYSQL_COMPLAINT_USER}"
        password: "${MYSQL_COMPLAINT_PASSWORD}"
```

```md
## Role-Scoped Knowledge

- Role-specific docs live under `knowledge/<alias>/roles/<role>/`
- Optional shared docs live under `knowledge/<alias>/common/`
- Changes require `/mysql-query reload-knowledge` or agent restart
```

- [ ] **Step 2: Rewrite `knowledge/CLAUDE.md` structure examples**

```md
knowledge/
  <alias>/
    common/
      _catalog.md
      shared-runbook.md
    roles/
      complaint/
        _catalog.md
        complaint-analysis.md
      default/
        _catalog.md
        default-ops.md
```

- [ ] **Step 3: Run full plugin preflight**

Run:

```bash
cd /home/felix021/code/zhiliao/mysql-query
npm run preflight
```

Expected: PASS with lint, typecheck, and all Vitest suites green.

- [ ] **Step 4: Run the focused zhiliao agent suite**

Run:

```bash
cd /home/felix021/code/zhiliao/zhiliao/agent
npm test -- tests/agent/tool-registry.test.ts tests/agent/invoker.test.ts tests/channels/channel-router.test.ts tests/channels/feishu/adapter.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/felix021/code/zhiliao/mysql-query
git add README.md README_EN.md knowledge/CLAUDE.md config.example.yaml docs/superpowers/specs/2026-05-26-role-scoped-knowledge-design.md docs/superpowers/plans/2026-05-26-role-scoped-knowledge-plan.md
git commit -m "docs: document role-scoped mysql knowledge"
```

---

## Self-Review

- Spec coverage:
  - role-scoped knowledge layout: Task 3 + Task 5
  - request-aware tool description and system prompt: Task 1 + Task 3
  - `allow_common_knowledge`: Task 3 + Task 5
  - explicit reload command: Task 2 + Task 4
  - observability logs: Task 3 + Task 4
  - docs updates: Task 5
- Placeholder scan:
  - no `TODO`/`TBD`
  - every code-changing step includes code
  - every test step includes exact commands
- Type consistency:
  - `RequestContext` is the metadata path type
  - `CommandCallContext.isAdmin` is the reload command auth bit
  - `knowledgeByAlias` is the single in-memory snapshot source

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-26-role-scoped-knowledge-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
