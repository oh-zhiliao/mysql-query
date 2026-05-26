import { describe, it, expect, vi, beforeEach } from "vitest";

const { createPoolMock } = vi.hoisted(() => ({
  createPoolMock: vi.fn((opts: Record<string, any>) => ({
    options: opts,
    query: vi.fn().mockResolvedValue([
      [{ id: 1, account_user: opts.user }],
      [{ name: "id" }, { name: "account_user" }],
    ]),
    end: vi.fn(),
  })),
}));

vi.mock("mysql2/promise", () => ({
  default: {
    createPool: createPoolMock,
  },
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      if (typeof path === "string" && path.includes("knowledge")) return false;
      return actual.existsSync(path);
    }),
  };
});

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

  it("accepts aliases that only define a non-default role account", async () => {
    await expect(plugin.init({
      known_databases: {
        complaint_only: {
          host: "127.0.0.1",
          accounts: {
            complaint: { user: "complaint_user", password: "complaint_secret" },
          },
        },
      },
    })).resolves.toBeUndefined();
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

describe("role account resolution", () => {
  let plugin: MySQLQueryPlugin;

  beforeEach(async () => {
    plugin = new MySQLQueryPlugin();
    plugin.name = "mysql-query";
    await plugin.init(structuredClone(NEW_CONFIG));
  });

  it("uses the exact matching role account", () => {
    expect((plugin as any).resolveAccountKey("mydb", {
      channel: "feishu",
      userId: "ou_admin",
      role: "finance_admin",
      logId: "log1",
    })).toBe("finance_admin");
  });

  it("uses default when role is absent", () => {
    expect((plugin as any).resolveAccountKey("mydb", {
      channel: "webchat",
      userId: "u1",
      logId: "log1",
    })).toBe("default");
  });

  it("treats an explicit default role as the default account", () => {
    expect((plugin as any).resolveAccountKey("mydb", {
      channel: "feishu",
      userId: "ou_default",
      role: "default",
      logId: "log1",
    })).toBe("default");
  });

  it("denies unmapped non-default roles", () => {
    expect(() => (plugin as any).resolveAccountKey("mydb", {
      channel: "feishu",
      userId: "ou_admin",
      role: "analyst",
      logId: "log1",
    })).toThrow(/not configured/i);
  });

  it("denies prototype-chain role names", () => {
    expect(() => (plugin as any).resolveAccountKey("mydb", {
      channel: "feishu",
      userId: "ou_admin",
      role: "__proto__",
      logId: "log1",
    })).toThrow(/not configured/i);
  });

  it("denies default callers when an alias has no default account", async () => {
    const complaintOnlyPlugin = new MySQLQueryPlugin();
    complaintOnlyPlugin.name = "mysql-query";
    await complaintOnlyPlugin.init({
      known_databases: {
        complaint_only: {
          host: "127.0.0.1",
          accounts: {
            complaint: { user: "complaint_user", password: "complaint_secret" },
          },
        },
      },
    });

    expect(() => (complaintOnlyPlugin as any).resolveAccountKey("complaint_only", {
      channel: "webchat",
      userId: "u1",
      logId: "log1",
    })).toThrow(/default/i);
  });
});

describe("role-aware query execution", () => {
  let plugin: MySQLQueryPlugin;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    createPoolMock.mockClear();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    plugin = new MySQLQueryPlugin();
    plugin.name = "mysql-query";
    await plugin.init(structuredClone(NEW_CONFIG));
  });

  it("creates separate pools for default and role-specific accounts", async () => {
    const defaultResult = await plugin.executeTool("query", {
      database: "mydb",
      sql: "SELECT 1",
    }, {
      channel: "webchat",
      userId: "u-default",
      logId: "log-default",
    });

    const adminResult = await plugin.executeTool("query", {
      database: "mydb",
      sql: "SELECT 1",
    }, {
      channel: "feishu",
      userId: "ou-admin",
      role: "finance_admin",
      logId: "log-admin",
    });

    expect(createPoolMock).toHaveBeenCalledTimes(2);
    expect(createPoolMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      user: "readonly_user",
      password: "secret123",
    }));
    expect(createPoolMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      user: "finance_user",
      password: "finance_secret",
    }));
    expect(defaultResult).toContain("readonly_user");
    expect(adminResult).toContain("finance_user");
  });

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
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining(
      "[mysql-query] query logId=log1 requestedRole=finance_admin account=finance_admin instance=mydb database=reporting mode=instance",
    ));
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

  it("reuses the same pool for repeated queries under the same role", async () => {
    await plugin.executeTool("query", {
      database: "mydb",
      sql: "SELECT 1",
    }, {
      channel: "feishu",
      userId: "ou-admin",
      role: "finance_admin",
      logId: "log-admin-1",
    });

    await plugin.executeTool("query", {
      database: "mydb",
      sql: "SELECT 2",
    }, {
      channel: "feishu",
      userId: "ou-admin",
      role: "finance_admin",
      logId: "log-admin-2",
    });

    expect(createPoolMock).toHaveBeenCalledTimes(1);
  });

  it("uses the default account when context is omitted entirely", async () => {
    const result = await plugin.executeTool("query", {
      database: "mydb",
      sql: "SELECT 1",
    });

    expect(createPoolMock).toHaveBeenCalledTimes(1);
    expect(createPoolMock).toHaveBeenCalledWith(expect.objectContaining({
      user: "readonly_user",
      password: "secret123",
    }));
    expect(result).toContain("readonly_user");
  });

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

  it("rejects invalid physical database names before pool creation", async () => {
    const result = await plugin.executeTool("query", {
      instance: "mydb",
      database: "wizard;drop",
      sql: "SELECT 1",
    });

    expect(result).toMatch(/invalid physical database name/i);
    expect(createPoolMock).not.toHaveBeenCalled();
  });

  it("fails closed for queries from unmapped non-default roles", async () => {
    await expect(plugin.executeTool("query", {
      database: "mydb",
      sql: "SELECT 1",
    }, {
      channel: "feishu",
      userId: "ou-analyst",
      role: "analyst",
      logId: "log-analyst",
    })).resolves.toMatch(/access denied/i);
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

    expect(createPoolMock).toHaveBeenCalledTimes(1);
    expect(createPoolMock).toHaveBeenCalledWith(expect.objectContaining({
      database: "warehouse",
      user: "finance_user",
    }));
    expect(instanceResult).toContain("account_user");
    expect(legacyResult).toContain("account_user");
  });

  it("closes lazily created pools on destroy", async () => {
    await plugin.executeTool("query", {
      database: "mydb",
      sql: "SELECT 1",
    });
    await plugin.executeTool("query", {
      database: "mydb",
      sql: "SELECT 1",
    }, {
      channel: "feishu",
      userId: "ou-admin",
      role: "finance_admin",
      logId: "log-admin",
    });

    const createdPools = createPoolMock.mock.results.map((result) => result.value);
    await plugin.destroy();

    expect(createdPools).toHaveLength(2);
    for (const pool of createdPools) {
      expect(pool.end).toHaveBeenCalledTimes(1);
    }
  });
});
