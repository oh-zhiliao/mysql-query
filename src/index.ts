import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import type {
  ToolPlugin,
  ToolDefinition,
  RequestContext,
  PluginCommandHandler,
} from "../../../src/agent/tool-plugin.js";

import mysql from "mysql2/promise";
import type { Pool, PoolOptions } from "mysql2/promise";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, "..");
const DEFAULT_KNOWLEDGE_DIR = resolve(PLUGIN_ROOT, "knowledge");
const DATABASE_NAME_RE = /^[A-Za-z0-9_-]+$/;

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

interface KnowledgeScope {
  description: string;
  catalogBody: string;
  docs: Map<string, TopicDocMeta>;
}

interface AliasKnowledgeSnapshot {
  roleScopes: Map<string, KnowledgeScope>;
  commonScope?: KnowledgeScope;
}

interface VisibleKnowledge {
  role: string;
  roleScope?: KnowledgeScope;
  commonScope?: KnowledgeScope;
  hasRoleCatalog: boolean;
  hasCommonCatalog: boolean;
}

interface ResolvedQueryTarget {
  alias: string;
  physicalDatabase: string;
  legacyMode: boolean;
}

interface MySQLQueryConfig {
  known_databases: Record<string, DatabaseConfig>;
  allow_common_knowledge?: boolean;
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
  private knowledgeByAlias = new Map<string, AliasKnowledgeSnapshot>();
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
      // Role-scoped alias visibility means some aliases may be intentionally
      // hidden from default callers, so we only require "at least one account"
      // instead of globally requiring accounts.default.
      if (!db.accounts || Object.keys(db.accounts).length === 0) {
        throw new Error(`Database "${name}" must define at least one account`);
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
    this.knowledgeByAlias = this.loadKnowledgeSnapshot();
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

  // Knowledge is snapshotted at startup/reload time so request handling stays
  // deterministic and we can reject broken edits without serving half-loaded state.
  private loadKnowledgeSnapshot(): Map<string, AliasKnowledgeSnapshot> {
    const snapshot = new Map<string, AliasKnowledgeSnapshot>();
    if (!existsSync(this.knowledgeDir)) return snapshot;

    for (const alias of Object.keys(this.config.known_databases)) {
      const aliasDir = join(this.knowledgeDir, alias);
      if (!existsSync(aliasDir)) continue;

      const aliasSnapshot: AliasKnowledgeSnapshot = {
        roleScopes: new Map<string, KnowledgeScope>(),
      };

      const commonScope = this.readKnowledgeScope(alias, join(aliasDir, "common"), "common");
      if (commonScope) {
        aliasSnapshot.commonScope = commonScope;
      }

      const rolesDir = join(aliasDir, "roles");
      if (existsSync(rolesDir)) {
        for (const roleEntry of readdirSync(rolesDir, { withFileTypes: true })) {
          if (!roleEntry.isDirectory()) continue;
          const scope = this.readKnowledgeScope(alias, join(rolesDir, roleEntry.name), `roles/${roleEntry.name}`);
          if (scope) {
            aliasSnapshot.roleScopes.set(roleEntry.name, scope);
          }
        }
      }

      if (aliasSnapshot.roleScopes.size > 0 || aliasSnapshot.commonScope) {
        snapshot.set(alias, aliasSnapshot);
      }
    }

    return snapshot;
  }

  private readKnowledgeScope(alias: string, scopeDir: string, scopeLabel: string): KnowledgeScope | undefined {
    if (!existsSync(scopeDir)) return undefined;

    const entries = readdirSync(scopeDir, { withFileTypes: true });
    const docEntries = entries.filter((entry) =>
      entry.isFile() && entry.name.endsWith(".md") && entry.name !== "_catalog.md" && entry.name !== "CLAUDE.md"
    );
    const catalogPath = join(scopeDir, "_catalog.md");

    if (!existsSync(catalogPath)) {
      if (docEntries.length === 0) return undefined;
      throw new Error(`Knowledge scope "${alias}/${scopeLabel}" is invalid: missing _catalog.md`);
    }

    const catalogContent = readFileSync(catalogPath, "utf-8");
    const { meta, body } = parseFrontmatter(catalogContent);
    const docs = new Map<string, TopicDocMeta>();

    for (const entry of docEntries) {
      const docName = entry.name.replace(/\.md$/, "");
      const docPath = join(scopeDir, entry.name);
      const docContent = readFileSync(docPath, "utf-8");
      const docParsed = parseFrontmatter(docContent);
      docs.set(docName, {
        title: docParsed.meta.title || docName,
        description: docParsed.meta.description || "",
        filePath: docPath,
      });
    }

    return {
      description: meta.description || "",
      catalogBody: body.trim(),
      docs,
    };
  }

  getToolDefinitions(context?: RequestContext): ToolDefinition[] {
    const visibleAliases = this.getVisibleAliases(context);
    const dbList = visibleAliases
      .map((alias) => {
        const visible = this.resolveVisibleKnowledge(alias, context);
        const description = visible.roleScope?.description || visible.commonScope?.description || "configured database alias";
        this.logKnowledgeVisibility(alias, visible);
        return `  - "${alias}" — ${description}`;
      })
      .join("\n");

    const tools: ToolDefinition[] = [
      {
        name: "query",
        description: [
          "Execute a read-only SQL query against a configured MySQL database.",
          "Only SELECT, SHOW, DESCRIBE, and EXPLAIN statements are allowed.",
          "Use `instance` for the configured connection alias.",
          "Use optional `database` for the physical target database/schema.",
          "Legacy callers may still send `database=<alias>`, but new callers should prefer `instance + database`.",
          "",
          "Known databases:",
          dbList || "  (none visible)",
          "",
          "Use get_topic_knowledge to load detailed schema info and query patterns before writing complex queries.",
        ].join("\n"),
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
              description: "SQL query to execute. Only read-only statements (SELECT, SHOW, DESCRIBE, EXPLAIN) are allowed.",
            },
            limit: {
              type: "number",
              description: "Max rows to return. Default: 100, max: 1000. Applied as LIMIT clause if not already present in the query.",
              default: 100,
            },
          },
          required: ["sql"],
        },
      },
    ];

    const availableDocs = visibleAliases
      .flatMap((alias) => {
        const visible = this.resolveVisibleKnowledge(alias, context);
        const docs = new Map<string, TopicDocMeta>();
        for (const [docName, docMeta] of visible.commonScope?.docs ?? []) {
          docs.set(docName, docMeta);
        }
        for (const [docName, docMeta] of visible.roleScope?.docs ?? []) {
          docs.set(docName, docMeta);
        }
        return Array.from(docs.entries()).map(([doc, meta]) =>
          `  - database="${alias}", doc="${doc}": ${meta.description || meta.title}`
        );
      })
      .join("\n");

    if (availableDocs) {
      tools.push({
        name: "get_topic_knowledge",
        description: [
          "Load a detailed knowledge document for a MySQL database. Use this before writing complex queries to get schema details, query patterns, and analysis recipes.",
          "For this tool, `database` still means the configured alias used by the knowledge directory.",
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
        return this.getTopicKnowledge(input, context);
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
    const instance = input.instance || input.database || "?";
    const maybePhysical = input.instance ? (input.database || "(default)") : "(legacy default)";
    const sql = input.sql || "";
    const preview = sql.length > 80 ? sql.slice(0, 80) + "..." : sql;
    return `MySQL query: instance=${instance} database=${maybePhysical}${input.instance ? "" : " mode=legacy"} — ${preview}`;
  }

  getSystemPromptAddendum(context?: RequestContext): string {
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

    const visibleAliases = this.getVisibleAliases(context);
    const visibleCatalogs = visibleAliases
      .map((alias) => ({ alias, visible: this.resolveVisibleKnowledge(alias, context) }))
      .filter(({ alias, visible }) => {
        this.logKnowledgeVisibility(alias, visible);
        return Boolean(visible.roleScope?.catalogBody || visible.commonScope?.catalogBody);
      });

    if (visibleCatalogs.length > 0) {
      lines.push("", "### Known Databases");
      for (const { alias, visible } of visibleCatalogs) {
        lines.push("", `**${alias}**`);
        if (visible.roleScope?.catalogBody) {
          lines.push(visible.roleScope.catalogBody);
        }
        if (visible.commonScope?.catalogBody) {
          lines.push(visible.commonScope.catalogBody);
        }
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

  getCommandHandlers(): PluginCommandHandler {
    return {
      subcommands: {
        "reload-knowledge": {
          description: "Reload role-scoped knowledge from disk",
          handle: async (_args, context) => {
            if (!context.isAdmin) {
              return "Only admins can run /mysql-query reload-knowledge.";
            }
            console.log(`[mysql-query] knowledge reload started: by=${context.userId}`);
            try {
              const stats = this.reloadKnowledge();
              console.log(
                `[mysql-query] knowledge reload finished: aliases=${stats.aliases} roleScopes=${stats.roleScopes} commonScopes=${stats.commonScopes}`,
              );
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

  private reloadKnowledge(): { aliases: number; roleScopes: number; commonScopes: number } {
    const next = this.loadKnowledgeSnapshot();
    this.knowledgeByAlias = next;
    return this.countKnowledgeScopes(next);
  }

  private countKnowledgeScopes(snapshot: Map<string, AliasKnowledgeSnapshot>) {
    let roleScopes = 0;
    let commonScopes = 0;
    for (const aliasKnowledge of snapshot.values()) {
      roleScopes += aliasKnowledge.roleScopes.size;
      if (aliasKnowledge.commonScope) commonScopes++;
    }
    return { aliases: snapshot.size, roleScopes, commonScopes };
  }

  private resolveAccountKey(dbName: string, context?: RequestContext): string {
    const db = this.config.known_databases[dbName];
    if (!db) {
      throw new Error(`Unknown database "${dbName}"`);
    }

    const role = context?.role;
    if (!role) {
      if (!db.accounts.default) {
        throw new Error(`Access denied: default role is not configured for database ${dbName}.`);
      }
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

  private buildPoolKey(alias: string, accountKey: string, physicalDatabase: string): string {
    return `${alias}\u0000${accountKey}\u0000${physicalDatabase}`;
  }

  private describePoolKey(poolKey: string): string {
    const [alias, accountKey, physicalDatabase] = poolKey.split("\u0000");
    if (!accountKey || !physicalDatabase) {
      return poolKey;
    }
    return `${alias} (role=${accountKey}, database=${physicalDatabase})`;
  }

  private getOrCreatePool(alias: string, accountKey: string, physicalDatabase: string): Pool {
    const poolKey = this.buildPoolKey(alias, accountKey, physicalDatabase);
    const existing = this.pools.get(poolKey);
    if (existing) {
      return existing;
    }

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

  private getVisibleAliases(context?: RequestContext): string[] {
    const role = context?.role ?? "default";
    return Object.entries(this.config.known_databases)
      .filter(([, db]) => role === "default" ? Boolean(db.accounts.default) : Object.hasOwn(db.accounts, role))
      .map(([alias]) => alias);
  }

  private resolveVisibleKnowledge(alias: string, context?: RequestContext): VisibleKnowledge {
    const role = context?.role ?? "default";
    const aliasKnowledge = this.knowledgeByAlias.get(alias);
    const roleScope = aliasKnowledge?.roleScopes.get(role);
    const commonScope = this.config.allow_common_knowledge ? aliasKnowledge?.commonScope : undefined;
    return {
      role,
      roleScope,
      commonScope,
      hasRoleCatalog: Boolean(aliasKnowledge?.roleScopes.has(role)),
      hasCommonCatalog: Boolean(aliasKnowledge?.commonScope),
    };
  }

  private logKnowledgeVisibility(alias: string, visible: VisibleKnowledge): void {
    const visibleDocCount = (visible.roleScope?.docs.size ?? 0) + (visible.commonScope?.docs.size ?? 0);
    if (visible.roleScope || visible.commonScope) {
      const scope = visible.roleScope && visible.commonScope ? "mixed" : visible.roleScope ? "role" : "common";
      console.log(`[mysql-query] knowledge resolved: role=${visible.role} alias=${alias} scope=${scope} docs=${visibleDocCount}`);
      return;
    }

    const reason = !visible.hasRoleCatalog
      ? (visible.hasCommonCatalog && !this.config.allow_common_knowledge ? "common_disabled" : "no_role_catalog")
      : "empty_scope";
    console.log(
      `[mysql-query] knowledge missing: role=${visible.role} alias=${alias} hasRoleCatalog=${visible.hasRoleCatalog ? "true" : "false"} hasCommonCatalog=${visible.hasCommonCatalog ? "true" : "false"} allowCommon=${this.config.allow_common_knowledge ? "true" : "false"} reason=${reason}`,
    );
  }

  private getTopicKnowledge(input: Record<string, any>, context?: RequestContext): string {
    const alias: string = input.database;
    const docName: string = input.doc;
    const visible = this.resolveVisibleKnowledge(alias, context);
    this.logKnowledgeVisibility(alias, visible);

    const docMeta = visible.roleScope?.docs.get(docName) || visible.commonScope?.docs.get(docName);
    if (!docMeta) {
      console.log(
        `[mysql-query] knowledge denied: role=${visible.role} alias=${alias} doc=${docName} allowCommon=${this.config.allow_common_knowledge ? "true" : "false"}`,
      );
      return `No knowledge document is available for alias "${alias}" under role "${visible.role}".`;
    }

    try {
      return readFileSync(docMeta.filePath, "utf-8");
    } catch (err: any) {
      return `Error reading knowledge file: ${err.message}`;
    }
  }

  private async executeQuery(input: Record<string, any>, context?: RequestContext): Promise<string> {
    try {
      const target = this.resolveQueryTarget(input);
      const sql: string = input.sql;
      const limit: number = Math.min(input.limit || 100, 1000);

      if (!isReadOnlyQuery(sql)) {
        return "Error: Only read-only queries are allowed (SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, WITH). Write operations are blocked for safety.";
      }

      const accountKey = this.resolveAccountKey(target.alias, context);
      const requestedRole = context?.role || "default";
      console.log(
        `[mysql-query] query logId=${context?.logId || "-"} requestedRole=${requestedRole} account=${accountKey} instance=${target.alias} database=${target.physicalDatabase} mode=${target.legacyMode ? "legacy" : "instance"}`,
      );
      const pool = this.getOrCreatePool(target.alias, accountKey, target.physicalDatabase);
      const finalSql = this.applyLimit(sql, limit);
      const timeoutMs = this.config.known_databases[target.alias].query_timeout || 30000;

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
        `instance: ${target.alias}`,
        `database: ${target.physicalDatabase}`,
        `mode: ${target.legacyMode ? "legacy" : "instance"}`,
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
