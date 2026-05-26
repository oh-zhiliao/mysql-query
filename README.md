# MySQL Query — 知了数据库查询插件

MySQL 数据库查询插件，为[知了](https://github.com/git-zhiliao/zhiliao) Agent 提供只读 SQL 查询能力。

> [English version](README_EN.md)

## 功能

- **只读 SQL 查询**：执行 SELECT / SHOW / DESCRIBE / EXPLAIN 语句，自动拒绝写操作
- **自动 LIMIT**：未指定 LIMIT 的 SELECT 语句自动添加（默认 100，最大 1000），防止全表扫描
- **多数据库支持**：通过友好名称引用已配置的数据库，无需记忆连接信息
- **知识库系统**：role-scoped 知识隔离，按需加载查询模式，减少无意义试探
- **基于角色的数据库账号**：同一个数据库别名可按 `role` 选择不同的查询账号
- **运行时数据库选择**：配置 key 表示连接别名，物理库可在查询时通过 `instance + optional database` 指定
- **连接池管理**：每个数据库别名、role、物理库组合独立连接池，自动管理连接生命周期

## 提供的工具

| 工具名 | 说明 | 开销 |
|---|---|---|
| `mysql-query.query` | 执行只读 SQL 查询 | expensive |
| `mysql-query.get_topic_knowledge` | 按需加载数据库的详细查询模式文档 | cheap |

## 目录结构

```
mysql-query/
  config.yaml              # 数据库连接信息（gitignored）
  config.example.yaml      # 配置模板
  src/index.ts             # TypeScript 插件入口
  package.json             # 依赖（mysql2）
  knowledge/               # 知识库目录（gitignored，独立管理）
    CLAUDE.md              # 知识库编写指南
    {alias}/
      common/              # 可选公共知识（仅 allow_common_knowledge=true 时可见）
        _catalog.md
        {doc-name}.md
      roles/
        default/           # default role 专属知识
          _catalog.md
          {doc-name}.md
        complaint/         # complaint role 专属知识
          _catalog.md
          {doc-name}.md
```

## Role-Scoped 知识库

| 层级 | 来源 | 加载方式 | 内容 |
|---|---|---|---|
| 插件级 | 代码中硬编码 | 始终加载 | SQL 通用语法、安全限制、使用技巧 |
| role 目录 | `knowledge/{alias}/roles/{role}/_catalog.md` | 仅当前 role 可见 | 表结构、项目约定、文档索引 |
| 公共目录 | `knowledge/{alias}/common/*.md` | 仅 `allow_common_knowledge=true` 时可见 | 可跨 role 共享的非敏感知识 |
| 任务文档 | `roles/{role}/{doc}.md` / `common/{doc}.md` | 按需加载 | 详细查询模式、分析方法、排查手册 |

规则：

- 默认严格隔离：只读取 `roles/<role>/...`
- 若 `allow_common_knowledge: true`，则在 role 知识之外再附加 `common/...`
- `query` 工具只会向当前 role 暴露有权限的 alias
- 若 alias 可查询但知识尚未迁移，工具描述会退化成 `configured database alias`，同时打 `knowledge missing` 日志

## 安全机制

- **只读强制**：只允许 `SELECT`、`SHOW`、`DESCRIBE`、`DESC`、`EXPLAIN`、`WITH`（CTE）语句
- **写操作拦截**：`INSERT`、`UPDATE`、`DELETE`、`DROP`、`CREATE`、`ALTER`、`TRUNCATE` 等一律拒绝
- **密码过滤**：所有数据库密码通过 secret pattern 自动脱敏，防止泄露
- **权限兜底策略**：请求携带了非 default role 但该数据库未配置对应账号时，直接拒绝，不会自动降级到 default
- **查询超时**：可配置每个数据库的查询超时时间（默认 30s）

---

## Agent 指南：部署

本节面向负责部署插件的 Agent 或运维人员。

### 前置条件

- 知了 Agent 运行环境（Node.js + tsx）
- 目标 MySQL 数据库的只读账号

### 安装步骤

```bash
# 1. 克隆到插件目录
cd agent/plugins/
git clone git@github.com:git-zhiliao/mysql-query.git mysql-query

# 2. 安装依赖
cd mysql-query && npm install && cd ..

# 3. 配置
cp mysql-query/config.example.yaml mysql-query/config.yaml
# 编辑 config.yaml，填入真实连接信息
```

### 配置说明

编辑 `config.yaml`：

```yaml
allow_common_knowledge: false

known_databases:
  my_app:
    host: "127.0.0.1"
    port: 3306
    database: "my_app_db"   # 可选默认物理库
    accounts:
      default:
        user: "${MYSQL_USER}"
        password: "${MYSQL_PASSWORD}"
      finance_admin:
        user: "${MYSQL_FINANCE_ADMIN_USER}"
        password: "${MYSQL_FINANCE_ADMIN_PASSWORD}"
    # connect_timeout: 10000   # 连接超时（毫秒，默认 10000）
    # query_timeout: 30000     # 查询超时（毫秒，默认 30000）
```

说明：

- `known_databases.<key>` 里的 `<key>` 是连接别名，不是固定物理库名
- 配置里的 `database` 只是默认物理库；查询时也可以显式指定别的物理库
- `accounts.default` 是 default/legacy 调用使用的默认查询账号
- 当知了请求上下文里带了 `role` 时，插件会优先查 `accounts.<role>`
- 若请求 role 不是 `default` 且未配置对应账号，查询会直接拒绝，不回退到 `default`
- 某个 alias 可以只给特定 role 配账号；这种 alias 对 default 调用方不可见
- 旧的顶层 `user/password` 已移除，需要迁移到 `accounts.default`
- `allow_common_knowledge` 默认是 `false`，表示知识库默认严格按 role 隔离

推荐调用方式：

```json
{ "instance": "doris", "database": "wizard", "sql": "SELECT COUNT(*) FROM pay_users" }
```

兼容旧调用：

```json
{ "database": "doris", "sql": "SELECT COUNT(*) FROM pay_users" }
```

补充说明：

- 新写法里 `instance` 表示连接别名，`database` 表示本次查询要落到的物理库
- 旧写法里只有 `database=<alias>`，此时物理库只能来自配置里的默认 `database`
- 代码里保留了少量兼容注释，原因是过渡期同时存在两套输入语义，单看字段名容易误读

环境变量通过 `export` 导出，或在 `docker-compose.yml` 的 `environment` 中配置。

### 验证

```bash
# 启动知了 Agent 后检查日志
docker compose logs agent | grep "Plugin loaded"
# 预期输出: Plugin loaded: mysql-query (1 tools)
# 或（如有知识库）: Plugin loaded: mysql-query (2 tools)

# 如有知识库，还会看到 role-scoped 日志，例如:
# [mysql-query] knowledge resolved: role=default alias=my_app scope=role docs=N
```

### Docker 部署

插件目录通过 volume mount 进入容器：

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

## Agent 指南：知识库维护

知识库目录 `knowledge/` 被 gitignore，独立于插件代码管理。可由外部 Agent 生成、独立仓库管理或手动维护。

知识库更新后需显式生效：

- 管理员执行 `/mysql-query reload-knowledge`
- 或重启 agent

完整编写指南（目录结构、文件格式、命名原则、内容分层规则）见 [`knowledge/CLAUDE.md`](knowledge/CLAUDE.md)。
