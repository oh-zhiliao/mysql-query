import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("mysql2/promise", () => ({
  default: {
    createPool: vi.fn(() => ({
      query: vi.fn(),
      end: vi.fn(),
    })),
  },
}));

import MySQLQueryPlugin from "../src/index.js";

type KnowledgeTree = Record<string, {
  common?: {
    catalog?: string;
    docs?: Record<string, string>;
  };
  roles?: Record<string, {
    catalog?: string;
    docs?: Record<string, string>;
  }>;
}>;

interface InitOptions {
  allow_common_knowledge?: boolean;
  known_databases: Record<string, any>;
  knowledgeTree: KnowledgeTree;
}

interface InitResult {
  plugin: MySQLQueryPlugin;
  tmpDir: string;
}

function writeScope(dir: string, scope?: { catalog?: string; docs?: Record<string, string> }) {
  if (!scope) return;
  mkdirSync(dir, { recursive: true });
  if (scope.catalog !== undefined) {
    writeFileSync(join(dir, "_catalog.md"), scope.catalog);
  }
  for (const [name, body] of Object.entries(scope.docs ?? {})) {
    writeFileSync(join(dir, name), body);
  }
}

function writeKnowledgeTree(root: string, tree: KnowledgeTree) {
  for (const [alias, aliasTree] of Object.entries(tree)) {
    const aliasDir = join(root, alias);
    mkdirSync(aliasDir, { recursive: true });
    writeScope(join(aliasDir, "common"), aliasTree.common);
    for (const [role, scope] of Object.entries(aliasTree.roles ?? {})) {
      writeScope(join(aliasDir, "roles", role), scope);
    }
  }
}

async function initPluginWithKnowledge(options: InitOptions): Promise<InitResult> {
  const tmpDir = mkdtempSync(join(tmpdir(), "mysql-role-knowledge-"));
  writeKnowledgeTree(tmpDir, options.knowledgeTree);

  const plugin = new MySQLQueryPlugin();
  plugin.name = "mysql-query";
  await plugin.init({
    allow_common_knowledge: options.allow_common_knowledge ?? false,
    known_databases: options.known_databases,
    knowledge_dir: tmpDir,
  });

  return { plugin, tmpDir };
}

describe("mysql-query role-scoped knowledge", () => {
  const cleanupDirs: string[] = [];

  beforeEach(() => {
    cleanupDirs.length = 0;
  });

  afterEach(() => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("only exposes aliases and catalog content visible to the current role", async () => {
    const { plugin, tmpDir } = await initPluginWithKnowledge({
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
    cleanupDirs.push(tmpDir);

    const requestContext = {
      channel: "feishu",
      userId: "ou1",
      role: "complaint",
      logId: "log1",
    } as const;
    const defs = plugin.getToolDefinitions(requestContext);
    const addendum = plugin.getSystemPromptAddendum?.(requestContext) ?? "";

    expect(JSON.stringify(defs)).toContain("doris");
    expect(JSON.stringify(defs)).not.toContain("finance");
    expect(addendum).toContain("tickets");
    expect(addendum).not.toContain("ledger");
  });

  it("denies docs outside the visible role scope and logs why knowledge is missing", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { plugin, tmpDir } = await initPluginWithKnowledge({
      allow_common_knowledge: false,
      known_databases: {
        doris: {
          host: "127.0.0.1",
          database: "wizard",
          accounts: {
            complaint: { user: "complaint", password: "secret2" },
            default: { user: "readonly", password: "secret1" },
          },
        },
      },
      knowledgeTree: {
        doris: {
          common: {
            catalog: "---\ndescription: common\n---\nCommon catalog",
            docs: { "shared.md": "---\ntitle: Shared\n---\nShared doc" },
          },
        },
      },
    });
    cleanupDirs.push(tmpDir);

    const result = await plugin.executeTool("get_topic_knowledge", { database: "doris", doc: "shared" }, {
      channel: "feishu",
      userId: "ou1",
      role: "complaint",
      logId: "log1",
    } as const);

    expect(result).toMatch(/No knowledge document is available/i);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("knowledge denied"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("common_disabled"));
  });

  it("allows aliases that only have a non-default account and only exposes them to that role", async () => {
    const { plugin, tmpDir } = await initPluginWithKnowledge({
      known_databases: {
        complaint_only: {
          host: "127.0.0.1",
          accounts: {
            complaint: { user: "complaint", password: "secret2" },
          },
        },
      },
      knowledgeTree: {
        complaint_only: {
          roles: {
            complaint: {
              catalog: "---\ndescription: complaint-only\n---\nComplaint-only catalog",
              docs: { "complaint-only.md": "---\ntitle: Complaint Only\n---\n" },
            },
          },
        },
      },
    });
    cleanupDirs.push(tmpDir);

    expect(JSON.stringify(plugin.getToolDefinitions({ channel: "feishu", userId: "u1", role: "complaint", logId: "log1" } as const))).toContain("complaint_only");
    expect(JSON.stringify(plugin.getToolDefinitions({ channel: "feishu", userId: "u1", role: "default", logId: "log2" } as const))).not.toContain("complaint_only");
  });

  it("keeps visible aliases queryable with generic descriptions before knowledge migration and logs why", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { plugin, tmpDir } = await initPluginWithKnowledge({
      known_databases: {
        doris: {
          host: "127.0.0.1",
          database: "wizard",
          accounts: {
            default: { user: "readonly", password: "secret1" },
          },
        },
      },
      knowledgeTree: {},
    });
    cleanupDirs.push(tmpDir);

    const defs = plugin.getToolDefinitions({ channel: "feishu", userId: "u1", role: "default", logId: "log1" } as const);
    const addendum = plugin.getSystemPromptAddendum?.({ channel: "feishu", userId: "u1", role: "default", logId: "log1" } as const) ?? "";

    expect(JSON.stringify(defs)).toContain("configured database alias");
    expect(addendum).not.toContain("**doris**");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("knowledge missing"));
  });

  it("reloads knowledge only for admins and preserves the old snapshot on failure", async () => {
    const { plugin, tmpDir } = await initPluginWithKnowledge({
      known_databases: {
        doris: {
          host: "127.0.0.1",
          database: "wizard",
          accounts: {
            complaint: { user: "complaint", password: "secret2" },
            default: { user: "readonly", password: "secret1" },
          },
        },
      },
      knowledgeTree: {
        doris: {
          roles: {
            complaint: {
              catalog: "---\ndescription: complaint\n---\nold catalog body",
              docs: { "complaint.md": "---\ntitle: Complaint\n---\nOld body" },
            },
          },
        },
      },
    });
    cleanupDirs.push(tmpDir);

    const handlers = plugin.getCommandHandlers?.();
    expect(handlers).toBeDefined();

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

    const brokenRoleDir = join(tmpDir, "doris", "roles", "complaint");
    rmSync(join(brokenRoleDir, "_catalog.md"));
    writeFileSync(join(brokenRoleDir, "broken.md"), "---\ntitle: Broken\n---\nBroken body");

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
    expect(plugin.getSystemPromptAddendum?.({ channel: "feishu", userId: "ou1", role: "complaint", logId: "log1" } as const)).toContain("old catalog body");
  });
});
