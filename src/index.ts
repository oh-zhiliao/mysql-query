import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { ToolPlugin, ToolDefinition, RequestContext } from "../../../src/agent/tool-plugin.js";

import mysql from "mysql2/promise";
import type { Pool, PoolOptions } from "mysql2/promise";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, "..");
const DEFAULT_KNOWLEDGE_DIR = resolve(PLUGIN_ROOT, "knowledge");

interface AccountConfig {
  user: string;
  password: string;
}

interface DatabaseConfig {
  host: string;
  port?: number;
  database?: string;
  connect_timeout?: number;
  query_timeout?: number;
  accounts: Record<string, AccountConfig>;
}

interface TopicDocMeta {
  title: string;
  description: string;
  filePath: string;
}

interface TopicKnowledge {
  description: string;
  catalogBody: string;
  docs: Map<string, TopicDocMeta>;
}

interface MySQLQueryConfig {
  known_databases: Record<string, DatabaseConfig>;
  /** Absolute path override for the knowledge directory. When set, overrides the
   *  default colocated `{plugin_root}/knowledge`. Useful for deploy environments
   *  that want knowledge files isolated from the plugin source tree. */
  knowledge_dir?: string;
}

const READONLY_PREFIXES = ["select", "show", "describe", "desc", "explain", "with"];

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const sep = line.indexOf(":");
    if (sep > 0) {
      const key = line.slice(0, sep).trim();
      let val = line.slice(sep + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      meta[key] = val;
    }
  }
  return { meta, body: match[2] };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isReadOnlyQuery(sql: string): boolean {
  const trimmed = sql.replace(/^[\s;]+/, "").toLowerCase();
  return READONLY_PREFIXES.some(prefix => trimmed.startsWith(prefix));
}

export default class MySQLQueryPlugin implements ToolPlugin {
  name = "";
  private config!: MySQLQueryConfig;
  private pools = new Map<string, Pool>();
  private knowledge = new Map<string, TopicKnowledge>();
  private knowledgeDir = DEFAULT_KNOWLEDGE_DIR;

  async init(config: Record<string, any>): Promise<void> {
    if (!config.known_databases || Object.keys(config.known_databases).length === 0) {
      throw new Error("No known_databases configured in config.yaml");
    }

    for (const [name, db] of Object.entries(config.known_databases as Record<string, DatabaseConfig>)) {
      if (!db.host) {
        throw new Error(`Database "${name}" missing required field (host)`);
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
        if (account.password.startsWith("${") || account.user.startsWith("${")) {
          throw new Error(`Database "${name}" account "${accountKey}": env var not resolved — check environment variables`);
        }
      }
    }

    this.config = config as MySQLQueryConfig;
    if (this.config.knowledge_dir) {
      this.knowledgeDir = this.config.knowledge_dir;
    }
    this.loadKnowledge();
  }

  async destroy(): Promise<void> {
    for (const [name, pool] of this.pools.entries()) {
      try {
        await pool.end();
      } catch (err: any) {
        console.error(`Error closing pool for "${this.describePoolKey(name)}": ${err.message}`);
      }
    }
    this.pools.clear();
  }

  private loadKnowledge(): void {
    if (!existsSync(this.knowledgeDir)) return;

    const dbNames = Object.keys(this.config.known_databases);
    for (const dbName of dbNames) {
      const topicDir = join(this.knowledgeDir, dbName);
      if (!existsSync(topicDir)) continue;

      const catalogPath = join(topicDir, "_catalog.md");
      if (!existsSync(catalogPath)) {
        console.warn(`Knowledge dir for "${dbName}" exists but missing _catalog.md, skipping`);
        continue;
      }

      const catalogContent = readFileSync(catalogPath, "utf-8");
      const { meta, body } = parseFrontmatter(catalogContent);

      const docs = new Map<string, TopicDocMeta>();
      const entries = readdirSync(topicDir);
      for (const entry of entries) {
        if (!entry.endsWith(".md") || entry === "_catalog.md" || entry === "CLAUDE.md") continue;
        const docName = entry.replace(/\.md$/, "");
        const docPath = join(topicDir, entry);
        const docContent = readFileSync(docPath, "utf-8");
        const docParsed = parseFrontmatter(docContent);
        docs.set(docName, {
          title: docParsed.meta.title || docName,
          description: docParsed.meta.description || "",
          filePath: docPath,
        });
      }

      this.knowledge.set(dbName, {
        description: meta.description || "",
        catalogBody: body.trim(),
        docs,
      });

      console.log(`  Knowledge loaded for "${dbName}": catalog + ${docs.size} docs`);
    }
  }

  getToolDefinitions(): ToolDefinition[] {
    const dbList = Object.entries(this.config.known_databases)
      .map(([name, _db]) => {
        const k = this.knowledge.get(name);
        let line = `  - "${name}"`;
        if (k?.description) line += ` — ${k.description}`;
        return line;
      })
      .join("\n");

    const tools: ToolDefinition[] = [
      {
        name: "query",
        description: [
          "Execute a read-only SQL query against a configured MySQL database.",
          "Only SELECT, SHOW, DESCRIBE, and EXPLAIN statements are allowed.",
          "",
          "Known databases:",
          dbList,
          "",
          "Use get_topic_knowledge to load detailed schema info and query patterns before writing complex queries.",
        ].join("\n"),
        input_schema: {
          type: "object",
          properties: {
            database: {
              type: "string",
              description: "Known database name (must match a key in known_databases config)",
            },
            sql: {
              type: "string",
              description: "SQL query to execute. Only read-only statements (SELECT, SHOW, DESCRIBE, EXPLAIN) are allowed.",
            },
            limit: {
              type: "number",
              description: "Max rows to return. Default: 100, max: 1000. Applied as LIMIT clause if not already present in the query.",
              default: 100,
            },
          },
          required: ["database", "sql"],
        },
      },
    ];

    if (this.knowledge.size > 0) {
      const availableDocs = Array.from(this.knowledge.entries())
        .flatMap(([topic, k]) =>
          Array.from(k.docs.entries()).map(([doc, meta]) =>
            `  - database="${topic}", doc="${doc}": ${meta.description || meta.title}`
          )
        )
        .join("\n");

      tools.push({
        name: "get_topic_knowledge",
        description: [
          "Load a detailed knowledge document for a MySQL database. Use this before writing complex queries to get schema details, query patterns, and analysis recipes.",
          "",
          "Available docs:",
          availableDocs || "  (none)",
        ].join("\n"),
        input_schema: {
          type: "object",
          properties: {
            database: {
              type: "string",
              description: "Database name (must match a known database)",
            },
            doc: {
              type: "string",
              description: "Document name (without .md extension)",
            },
          },
          required: ["database", "doc"],
        },
      });
    }

    return tools;
  }

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

  getCheapTools(): string[] {
    return ["get_topic_knowledge"];
  }

  summarizeInput(name: string, input: Record<string, any>): string {
    if (name === "get_topic_knowledge") {
      return `knowledge: ${input.database}/${input.doc}`;
    }
    const db = input.database || "?";
    const sql = input.sql || "";
    const preview = sql.length > 80 ? sql.slice(0, 80) + "..." : sql;
    return `MySQL query: ${db} — ${preview}`;
  }

  getSystemPromptAddendum(): string {
    const lines: string[] = [
      "## MySQL Query Plugin",
      "",
      `Use ${this.name}.query to execute read-only SQL queries against MySQL databases.`,
      `Use ${this.name}.get_topic_knowledge to load detailed schema info and query patterns on-demand.`,
      "",
      "General tips:",
      "- Only read-only queries are allowed (SELECT, SHOW, DESCRIBE, EXPLAIN)",
      "- A LIMIT clause is auto-appended if not present (default 100, max 1000)",
      "- Start with DESCRIBE/SHOW to understand table schema before writing complex queries",
      "- Use EXPLAIN to check query plans for potentially slow queries",
      "- String literals use single quotes, identifiers use backticks",
      "",
      "### Query transparency",
      "When presenting MySQL results to the user, ALWAYS include:",
      "- The SQL query you used (in a code block) so the user can review your query logic",
      "- A brief explanation of query intent — what you were looking for and why this query captures it",
      "- If the query returned unexpected or empty results, explain what you tried and suggest alternatives",
      "",
      "### Cross-verification",
      "After getting MySQL results, cross-verify with git repo code when relevant:",
      "- If data shows a certain pattern, check the source code that writes/reads it to confirm the logic",
      "- If column values or enum meanings are unclear, check the code that defines them",
      "- Flag discrepancies between DB data and code — the user needs to know",
    ];

    lines.push(
      "",
      "### Security",
      "- NEVER reveal database connection details (host, port, IP address, username) to users",
      "- Only refer to databases by their alias name (e.g. 'doris')",
      "- If a user asks about connection info, say it is managed by the system",
    );

    if (this.knowledge.size > 0) {
      lines.push("", "### Known Databases");
      for (const [dbName, k] of this.knowledge.entries()) {
        lines.push("", `**${dbName}**`);
        if (k.catalogBody) {
          lines.push(k.catalogBody);
        }
      }
    } else {
      lines.push("", "### Known Databases", "");
      for (const [name, _db] of Object.entries(this.config.known_databases)) {
        lines.push(`- **${name}**`);
      }
    }

    return lines.join("\n");
  }

  getSecretPatterns(): RegExp[] {
    const patterns: RegExp[] = [];
    for (const db of Object.values(this.config.known_databases)) {
      if (db.host) {
        patterns.push(new RegExp(escapeRegex(db.host), "g"));
      }
      for (const account of Object.values(db.accounts)) {
        patterns.push(new RegExp(escapeRegex(account.password), "g"));
        patterns.push(new RegExp(escapeRegex(account.user), "g"));
      }
    }
    return patterns;
  }

  private resolveAccountKey(dbName: string, context?: RequestContext): string {
    const db = this.config.known_databases[dbName];
    if (!db) {
      throw new Error(`Unknown database "${dbName}"`);
    }

    const role = context?.role;
    if (!role) {
      return "default";
    }

    if (Object.hasOwn(db.accounts, role)) {
      return role;
    }

    throw new Error(`Access denied: role ${role} is not configured for database ${dbName}.`);
  }

  private getAccountConfig(dbName: string, accountKey: string): AccountConfig {
    const db = this.config.known_databases[dbName];
    if (!db || !Object.hasOwn(db.accounts, accountKey)) {
      throw new Error(`Access denied: role ${accountKey} is not configured for database ${dbName}.`);
    }
    return db.accounts[accountKey]!;
  }

  private buildPoolKey(dbName: string, accountKey: string): string {
    return `${dbName}\u0000${accountKey}`;
  }

  private describePoolKey(poolKey: string): string {
    const [dbName, accountKey] = poolKey.split("\u0000");
    if (!accountKey) {
      return poolKey;
    }
    return `${dbName} (role=${accountKey})`;
  }

  private getOrCreatePool(dbName: string, accountKey: string): Pool {
    const poolKey = this.buildPoolKey(dbName, accountKey);
    const existing = this.pools.get(poolKey);
    if (existing) {
      return existing;
    }

    const db = this.config.known_databases[dbName];
    if (!db) {
      throw new Error(`Unknown database "${dbName}"`);
    }
    const account = this.getAccountConfig(dbName, accountKey);
    const opts: PoolOptions = {
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
    };
    const pool = mysql.createPool(opts);
    this.pools.set(poolKey, pool);
    return pool;
  }

  private getTopicKnowledge(input: Record<string, any>): string {
    const dbName: string = input.database;
    const docName: string = input.doc;

    const topicKnowledge = this.knowledge.get(dbName);
    if (!topicKnowledge) {
      const available = Array.from(this.knowledge.keys()).join(", ");
      return `No knowledge found for database "${dbName}". Available databases with knowledge: ${available || "(none)"}`;
    }

    const docMeta = topicKnowledge.docs.get(docName);
    if (!docMeta) {
      const available = Array.from(topicKnowledge.docs.keys()).join(", ");
      return `No doc "${docName}" for database "${dbName}". Available docs: ${available || "(none)"}`;
    }

    try {
      return readFileSync(docMeta.filePath, "utf-8");
    } catch (err: any) {
      return `Error reading knowledge file: ${err.message}`;
    }
  }

  private async executeQuery(input: Record<string, any>, context?: RequestContext): Promise<string> {
    try {
      const dbName: string = input.database;
      const sql: string = input.sql;
      const limit: number = Math.min(input.limit || 100, 1000);

      const dbConfig = this.config.known_databases[dbName];
      if (!dbConfig) {
        const available = Object.keys(this.config.known_databases).join(", ");
        return `Unknown database "${dbName}". Available: ${available}`;
      }

      if (!isReadOnlyQuery(sql)) {
        return "Error: Only read-only queries are allowed (SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, WITH). Write operations are blocked for safety.";
      }

      const accountKey = this.resolveAccountKey(dbName, context);
      const pool = this.getOrCreatePool(dbName, accountKey);
      const finalSql = this.applyLimit(sql, limit);
      const timeoutMs = dbConfig.query_timeout || 30000;

      const [rows, fields] = await pool.query({ sql: finalSql, timeout: timeoutMs });

      if (!Array.isArray(rows)) {
        return JSON.stringify(rows, null, 2);
      }

      if (rows.length === 0) return "No results found.";

      const result = {
        row_count: rows.length,
        columns: fields?.map((f: any) => f.name) || [],
        rows,
      };

      const header = [
        `## SQL Used (MUST include in your answer)`,
        `database: ${dbName}`,
        `sql: ${finalSql}`,
        `rows: ${rows.length}`,
        ``,
        `When answering: (1) show this SQL in a code block, (2) explain what it does, (3) cross-verify with source code if relevant.`,
        ``,
        `## Data`,
      ].join("\n");

      return header + "\n" + JSON.stringify(result, null, 2);
    } catch (err: any) {
      return `Error in ${this.name}.query: ${err.message}`;
    }
  }

  private applyLimit(sql: string, limit: number): string {
    const trimmed = sql.replace(/;\s*$/, "").trim();
    const lower = trimmed.toLowerCase();

    // Only apply LIMIT to SELECT and WITH (CTE) statements
    if (!lower.startsWith("select") && !lower.startsWith("with")) {
      return trimmed;
    }

    // Don't add if LIMIT already present (simple heuristic: check if LIMIT appears outside of subqueries)
    // We check the top-level statement by looking at the tail end
    if (/\blimit\s+\d+/i.test(this.getOuterTail(trimmed))) {
      return trimmed;
    }

    return `${trimmed} LIMIT ${limit}`;
  }

  /**
   * Get the tail portion of the SQL that's not inside parentheses,
   * so we can check for top-level LIMIT clauses without matching subquery LIMITs.
   */
  private getOuterTail(sql: string): string {
    let depth = 0;
    let lastOuterStart = 0;
    for (let i = 0; i < sql.length; i++) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") {
        depth--;
        if (depth === 0) lastOuterStart = i + 1;
      }
    }
    return sql.slice(lastOuterStart);
  }
}
