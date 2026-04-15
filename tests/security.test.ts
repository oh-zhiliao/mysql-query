import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock mysql2/promise before importing the plugin
vi.mock("mysql2/promise", () => ({
  default: {
    createPool: vi.fn(() => ({
      query: vi.fn(),
      end: vi.fn(),
    })),
  },
}));

// Mock fs to avoid knowledge dir dependency
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      // Knowledge dir doesn't exist in tests
      if (typeof path === "string" && path.includes("knowledge")) return false;
      return actual.existsSync(path);
    }),
  };
});

import MySQLQueryPlugin from "../src/index.js";

const TEST_CONFIG = {
  known_databases: {
    mydb: {
      host: "10.0.0.1",
      port: 9030,
      user: "admin",
      password: "secret123",
      database: "warehouse",
    },
    secondary: {
      host: "192.168.1.100",
      port: 3306,
      user: "readonly_user",
      password: "p@ssw0rd!",
      database: "analytics",
    },
  },
};

describe("mysql-query security: no connection info leakage", () => {
  let plugin: MySQLQueryPlugin;

  beforeEach(async () => {
    plugin = new MySQLQueryPlugin();
    plugin.name = "mysql-query";
    await plugin.init(structuredClone(TEST_CONFIG));
  });

  describe("getToolDefinitions", () => {
    it("should NOT contain host addresses in tool descriptions", () => {
      const defs = plugin.getToolDefinitions();
      const allDescriptions = defs.map((d) => d.description).join("\n");

      expect(allDescriptions).not.toContain("10.0.0.1");
      expect(allDescriptions).not.toContain("192.168.1.100");
    });

    it("should NOT contain port numbers in tool descriptions", () => {
      const defs = plugin.getToolDefinitions();
      const allDescriptions = defs.map((d) => d.description).join("\n");

      expect(allDescriptions).not.toContain("9030");
      // 3306 might appear in generic docs, but not as part of host:port
      expect(allDescriptions).not.toMatch(/192\.168\.1\.100:3306/);
    });

    it("should NOT contain usernames in tool descriptions", () => {
      const defs = plugin.getToolDefinitions();
      const allDescriptions = defs.map((d) => d.description).join("\n");

      expect(allDescriptions).not.toContain("admin");
      expect(allDescriptions).not.toContain("readonly_user");
    });

    it("should still show database alias names", () => {
      const defs = plugin.getToolDefinitions();
      const allDescriptions = defs.map((d) => d.description).join("\n");

      expect(allDescriptions).toContain("mydb");
      expect(allDescriptions).toContain("secondary");
    });
  });

  describe("getSystemPromptAddendum", () => {
    it("should NOT contain host addresses", () => {
      const prompt = plugin.getSystemPromptAddendum();

      expect(prompt).not.toContain("10.0.0.1");
      expect(prompt).not.toContain("192.168.1.100");
    });

    it("should NOT contain port numbers in host:port format", () => {
      const prompt = plugin.getSystemPromptAddendum();

      expect(prompt).not.toContain("9030");
      expect(prompt).not.toMatch(/192\.168\.1\.100:3306/);
    });

    it("should NOT contain usernames", () => {
      const prompt = plugin.getSystemPromptAddendum();

      expect(prompt).not.toContain("admin");
      expect(prompt).not.toContain("readonly_user");
    });

    it("should still show database alias names", () => {
      const prompt = plugin.getSystemPromptAddendum();

      expect(prompt).toContain("mydb");
      expect(prompt).toContain("secondary");
    });

    it("should contain security instructions about not revealing connection details", () => {
      const prompt = plugin.getSystemPromptAddendum();

      expect(prompt).toMatch(/never.*reveal|do not.*reveal|never.*disclose/i);
      expect(prompt).toMatch(/host|connection/i);
    });
  });

  describe("getSecretPatterns", () => {
    it("should match passwords", () => {
      const patterns = plugin.getSecretPatterns();
      const text = "password is secret123 and also p@ssw0rd!";

      expect(patterns.some((p) => p.test(text))).toBe(true);
    });

    it("should match host addresses", () => {
      const patterns = plugin.getSecretPatterns();

      const hasHostPattern = patterns.some((p) => p.test("connect to 10.0.0.1"));
      expect(hasHostPattern).toBe(true);

      const hasSecondHost = patterns.some((p) => p.test("host is 192.168.1.100"));
      expect(hasSecondHost).toBe(true);
    });

    it("should match usernames", () => {
      const patterns = plugin.getSecretPatterns();

      const hasAdmin = patterns.some((p) => p.test("user: admin"));
      expect(hasAdmin).toBe(true);

      const hasReadonly = patterns.some((p) => p.test("user: readonly_user"));
      expect(hasReadonly).toBe(true);
    });
  });

  describe("executeQuery result header", () => {
    it("should NOT contain host/port info in query result header", async () => {
      // Mock the pool to return results
      const mockPool = {
        query: vi.fn().mockResolvedValue([
          [{ id: 1, name: "test" }],
          [{ name: "id" }, { name: "name" }],
        ]),
        end: vi.fn(),
      };

      // Access private pools map to inject mock
      (plugin as any).pools.set("mydb", mockPool);

      const result = await plugin.executeTool("query", {
        database: "mydb",
        sql: "SELECT * FROM users",
      });

      expect(result).not.toContain("10.0.0.1");
      expect(result).not.toContain("9030");
      expect(result).not.toContain("admin");
      // The alias name "mydb" is fine to show
      expect(result).toContain("mydb");
    });
  });
});
