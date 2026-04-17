import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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

const BASE_CONFIG = {
  known_databases: {
    doris: {
      host: "10.0.0.1",
      port: 9030,
      user: "admin",
      password: "secret123",
      database: "warehouse",
    },
  },
};

describe("MySQLQueryPlugin knowledge_dir override", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mysql-kd-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads knowledge from the overridden directory", async () => {
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

    const defs = plugin.getToolDefinitions();
    const kDef = defs.find((d) => d.name === "get_topic_knowledge");
    expect(kDef).toBeDefined();
    expect(kDef!.description).toContain("schema");

    const out = await plugin.executeTool("get_topic_knowledge", {
      database: "doris",
      doc: "schema",
    });
    expect(out).toContain("Schema details here");
  });

  it("silently skips when knowledge_dir does not exist", async () => {
    const missing = join(tmpDir, "does-not-exist");
    const plugin = new MySQLQueryPlugin();
    plugin.name = "mysql-query";
    await expect(
      plugin.init({ ...structuredClone(BASE_CONFIG), knowledge_dir: missing }),
    ).resolves.toBeUndefined();

    const defs = plugin.getToolDefinitions();
    expect(defs.find((d) => d.name === "get_topic_knowledge")).toBeUndefined();
  });

  it("exposes knowledge catalog in system prompt addendum", async () => {
    const topicDir = join(tmpDir, "doris");
    mkdirSync(topicDir, { recursive: true });
    writeFileSync(
      join(topicDir, "_catalog.md"),
      "---\ndescription: doris warehouse\n---\nDoris catalog body content\n",
    );

    const plugin = new MySQLQueryPlugin();
    plugin.name = "mysql-query";
    await plugin.init({ ...structuredClone(BASE_CONFIG), knowledge_dir: tmpDir });

    const prompt = plugin.getSystemPromptAddendum();
    expect(prompt).toContain("Doris catalog body content");
  });
});
