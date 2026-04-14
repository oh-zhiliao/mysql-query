# MySQL Query — 知了数据库查询插件

MySQL 数据库查询插件，为[知了](https://github.com/git-zhiliao/zhiliao) Agent 提供只读 SQL 查询能力。

> [English version](README_EN.md)

## 功能

- **只读 SQL 查询**：执行 SELECT / SHOW / DESCRIBE / EXPLAIN 语句，自动拒绝写操作
- **自动 LIMIT**：未指定 LIMIT 的 SELECT 语句自动添加（默认 100，最大 1000），防止全表扫描
- **多数据库支持**：通过友好名称引用已配置的数据库，无需记忆连接信息
- **知识库系统**：三层知识加载机制，按需加载查询模式，节省 token 开销
- **连接池管理**：每个数据库独立连接池，自动管理连接生命周期

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
    {db_name}/
      _catalog.md          # 表、约定、文档索引（始终加载）
      {doc-name}.md        # 任务导向的查询模式文档（按需加载）
```

## 知识库三层架构

| 层级 | 来源 | 加载方式 | 内容 |
|---|---|---|---|
| 插件级 | 代码中硬编码 | 始终加载 | SQL 通用语法、安全限制、使用技巧 |
| 数据库目录 | `knowledge/{db}/_catalog.md` | 始终加载 | 表结构、项目约定、文档索引 |
| 任务文档 | `knowledge/{db}/{doc}.md` | 按需加载 | 详细查询模式、分析方法、排查手册 |

## 安全机制

- **只读强制**：只允许 `SELECT`、`SHOW`、`DESCRIBE`、`DESC`、`EXPLAIN`、`WITH`（CTE）语句
- **写操作拦截**：`INSERT`、`UPDATE`、`DELETE`、`DROP`、`CREATE`、`ALTER`、`TRUNCATE` 等一律拒绝
- **密码过滤**：所有数据库密码通过 secret pattern 自动脱敏，防止泄露
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
known_databases:
  my_app:
    host: "127.0.0.1"
    port: 3306
    user: "${MYSQL_USER}"
    password: "${MYSQL_PASSWORD}"
    database: "my_app_db"
    # connect_timeout: 10000   # 连接超时（毫秒，默认 10000）
    # query_timeout: 30000     # 查询超时（毫秒，默认 30000）
```

环境变量通过 `export` 导出，或在 `docker-compose.yml` 的 `environment` 中配置。

### 验证

```bash
# 启动知了 Agent 后检查日志
docker compose logs agent | grep "Plugin loaded"
# 预期输出: Plugin loaded: mysql-query (1 tools)
# 或（如有知识库）: Plugin loaded: mysql-query (2 tools)

# 如有知识库，还会看到:
# Knowledge loaded for "my_app": catalog + N docs
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

完整编写指南（目录结构、文件格式、命名原则、内容分层规则）见 [`knowledge/CLAUDE.md`](knowledge/CLAUDE.md)。
