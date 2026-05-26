# Role-Scoped Knowledge for mysql-query

Date: 2026-05-26

## Background

`mysql-query` already routes database accounts by `context.role`, but its knowledge system is still effectively shared:

- startup loads knowledge by alias, not by role
- `get_topic_knowledge` does not filter docs by `context.role`
- `query` tool description still describes all configured aliases the same way for every role

This means a restricted role can still learn about unrelated tables or databases from shared knowledge, then spend many tool iterations probing databases it cannot meaningfully query.

The current production behavior shows this clearly: `role=complaint` correctly uses `account=complaint`, but the model still probes multiple physical databases because its knowledge is not role-scoped.

## Goals

- Strictly isolate `mysql-query` knowledge by role by default
- Optionally allow a role to read shared common knowledge via an explicit config switch
- Limit `query` tool alias descriptions to aliases the current role is allowed to query
- Add observability when knowledge resolution succeeds or fails
- Allow operators to explicitly reload knowledge without restarting the whole agent
- Update knowledge authoring documentation so operators know how to restructure docs
- Explicitly scope the required zhiliao core changes, because current tool metadata APIs are startup-time and request-agnostic

## Non-Goals

- No change to database-side authorization: actual data access is still enforced by the database account
- No change to request role resolution in zhiliao core
- No attempt to infer permissions from table names or SQL text inside the plugin
- No automatic filesystem watch or hot-reload on file change

## Design

### 1. Knowledge Layout

Knowledge remains keyed by configured alias, but the contents become role-scoped.

New layout:

```text
knowledge/
  CLAUDE.md
  <alias>/
    _catalog.md                    # optional deprecated alias-level summary, not used for role-scoped prompts
    common/
      _catalog.md                  # optional common catalog
      <doc>.md
    roles/
      <role>/
        _catalog.md                # required for role-specific knowledge
        <doc>.md
```

Rules:

- `knowledge/<alias>/roles/<role>/_catalog.md` is the primary catalog for that role when role-specific knowledge exists
- `knowledge/<alias>/common/_catalog.md` is only considered when `allow_common_knowledge=true`
- top-level `knowledge/<alias>/_catalog.md` remains optional only for migration bookkeeping; it is not loaded into role-scoped prompts or tool descriptions
- top-level role-agnostic task docs under `knowledge/<alias>/*.md` are deprecated and will no longer be loaded into role-scoped prompts

Reasoning:

- If alias-level `_catalog.md` still contributes prompt content, strict isolation is not real
- Putting `_catalog.md` inside `roles/<role>/` keeps schema knowledge and doc indices aligned with the role that can use them

### 1.5 Core Interface Dependency

This feature cannot be implemented purely inside `mysql-query`.

Current zhiliao core APIs expose tool metadata only at startup:

- `ToolPlugin.getToolDefinitions()` has no request context
- `ToolPlugin.getSystemPromptAddendum()` has no request context
- `ToolRegistry` aggregates both once per process without role-awareness

Because the user explicitly wants role-specific alias visibility in the `query` tool description, this design requires a zhiliao core interface change.

Required contract change:

- `getToolDefinitions(context?: RequestContext): ToolDefinition[]`
- `getSystemPromptAddendum(context?: RequestContext): string`
- `ToolRegistry.getToolDefinitions(context?: RequestContext): ToolDefinition[]`
- `ToolRegistry.getSystemPromptAddendum(context?: RequestContext): string`
- `CommandCallContext` should expose `isAdmin: boolean` for admin-only plugin commands such as `/mysql-query reload-knowledge`

Implementation may internally cache static data, but metadata generation must become request-aware.

### 2. Config

Add a plugin config flag:

```yaml
allow_common_knowledge: false
```

Semantics:

- default is `false`
- when `false`, only `roles/<role>/...` is visible
- when `true`, the role can read both `roles/<role>/...` and `common/...`

This flag is plugin-wide, not per alias. That is intentional to match the user's requested policy shape: strict by default, with one explicit switch for common knowledge.

To avoid over-broad exposure despite the plugin-wide flag:

- alias visibility is still gated first by role-specific account availability
- common knowledge is only considered for aliases that are already visible to the current role
- common knowledge never makes an otherwise invisible alias appear

### 3. Role-Scoped Knowledge Resolution

At runtime, `mysql-query` resolves knowledge using `context.role ?? "default"`.

Knowledge files are loaded once at startup into a nested in-memory structure:

- alias
- scope (`role:<role>` or `common`)
- catalog metadata
- visible docs

Per-request resolution then filters this in-memory structure by `context.role` and `allow_common_knowledge`.

This keeps runtime behavior request-aware without rescanning the filesystem on every tool call.

Knowledge reload semantics:

- startup and `/mysql-query reload-knowledge` both rebuild the same in-memory snapshot
- knowledge edits on disk are not visible until reload or process restart
- reload first validates the full tree, then atomically swaps the snapshot
- on reload failure, the previous snapshot remains active

For a given alias:

1. resolve role-specific catalog and docs from `roles/<role>/`
2. if `allow_common_knowledge=true`, additionally resolve common catalog and docs from `common/`
3. ignore deprecated top-level task docs
4. do not use alias-level `_catalog.md` in role-scoped prompt content or alias descriptions

Resolution output for each alias should include:

- `role`
- whether role-specific catalog exists
- whether common catalog exists
- visible docs map
- short alias description for `query` tool description, derived only from visible role/common scopes or a generic fallback

Validation rules for a knowledge snapshot:

- `roles/<role>/` is invalid if it contains any `*.md` knowledge docs but no `roles/<role>/_catalog.md`
- `common/` is invalid if it contains any `*.md` knowledge docs but no `common/_catalog.md`
- invalid scopes fail snapshot construction during explicit reload
- startup may log and skip missing knowledge roots, but once a scope is discovered it must satisfy the scope-level validation above

Knowledge changes on disk do not become visible automatically. This design adds an explicit command-based reload instead of a filesystem watcher.

### 4. query Tool Description Filtering

`query` tool description should only list aliases the current role can query.

Alias visibility is based on account availability:

- visible if `accounts.<role>` exists
- for `role=default` or missing context, visible if `accounts.default` exists
- non-default roles do not fall back to `accounts.default`
- if an alias is visible by account but has no visible knowledge, it may still appear with a generic description

Account configuration rules:

- an alias must define at least one account
- `accounts.default` is recommended but no longer required globally
- aliases that only serve a non-default role are valid
- default-role or legacy query callers cannot use aliases that omit `accounts.default`

The description for each visible alias should come from:

1. role-specific catalog description
2. common catalog description, if allowed
3. otherwise, a generic fallback such as `"configured database alias"`

The tool description must not expose:

- usernames
- passwords
- account keys beyond role names already implied by the request context

If a role has no configured account for an alias, that alias should not be listed. This is intentional. If the model somehow still calls the tool for that alias, existing runtime account resolution remains the final enforcement point and must continue returning access denied.

### 5. get_topic_knowledge Behavior

`get_topic_knowledge` becomes role-aware.

When called with `{ database: <alias>, doc: <doc> }`:

- resolve visible knowledge scopes for `context.role`
- allow docs only from role scope, plus common scope if enabled
- reject docs outside visible scopes

When the requested doc is not visible, return a clear non-sensitive error such as:

`No knowledge document is available for alias "<alias>" under role "<role>".`

### 5.5 System Prompt Leakage Closure

`getSystemPromptAddendum()` must become role-aware under the same request context contract described in section 1.5.

Current behavior injects catalog bodies for all aliases into the system prompt. This design explicitly replaces that with:

- only role-visible alias summaries
- only role-visible catalog content
- optional common content when enabled

Without this change, knowledge isolation is incomplete even if `get_topic_knowledge` is fixed.

### 6. Logging and Observability

Add request-time knowledge logs.

When knowledge resolves successfully for an alias:

```text
[mysql-query] knowledge resolved: role=<role> alias=<alias> scope=<role|common|mixed> docs=<n>
```

When no knowledge is visible for an alias:

```text
[mysql-query] knowledge missing: role=<role> alias=<alias> hasRoleCatalog=<true|false> hasCommonCatalog=<true|false> allowCommon=<true|false> reason=<no_role_catalog|common_disabled|empty_scope>
```

When `get_topic_knowledge` denies access to a doc:

```text
[mysql-query] knowledge denied: role=<role> alias=<alias> doc=<doc> allowCommon=<true|false>
```

These logs are required because operators need to distinguish:

- the role has no independent knowledge at all
- the role has no independent knowledge, but common knowledge exists and is currently disabled
- catalogs exist but no visible docs were resolved for the current scope
- the requested doc exists but is outside the role-visible scope

`reason` meanings:

- `no_role_catalog`: `roles/<role>/_catalog.md` does not exist and no visible fallback knowledge exists
- `common_disabled`: common knowledge exists, but `allow_common_knowledge=false`
- `empty_scope`: at least one visible catalog exists, but no docs were resolved for the requested operation

Tool metadata generation should also log when a role can query an alias but has no visible knowledge, so operators can distinguish:

- access exists but knowledge has not been migrated
- access does not exist, so the alias is intentionally hidden

This produces the same `knowledge missing` signal during:

- `query` tool description generation
- role-scoped system prompt generation
- `get_topic_knowledge` resolution

Reload operations should log:

```text
[mysql-query] knowledge reload started: by=<userId>
[mysql-query] knowledge reload finished: aliases=<n> roleScopes=<n> commonScopes=<n>
```

If reload fails:

```text
[mysql-query] knowledge reload failed: by=<userId> error=<message>
```

### 6.5 Explicit Reload Command

Add a plugin command:

```text
/mysql-query reload-knowledge
```

Behavior:

- reloads knowledge from disk into the in-memory alias/scope structure
- does not rebuild database pools
- does not require agent restart
- returns a concise success or failure message to the caller

Authorization:

- admin-only
- use the same admin gate already applied to other sensitive operational commands in zhiliao

Error handling:

- if the new knowledge tree is invalid, keep serving the previous in-memory snapshot
- only swap in the new snapshot after a full successful reload

Reasoning:

- explicit reload solves the operational need without introducing file-watch complexity
- copy-on-success reload avoids partially broken knowledge state after a bad edit

### 7. Documentation Updates

Implementation must update the knowledge-related docs, not just code.

Required doc updates:

- `README.md`
  - explain role-scoped knowledge layout
  - document `allow_common_knowledge`
  - explain that `query` alias visibility is role-sensitive
  - document `/mysql-query reload-knowledge`
- `README_EN.md`
  - same content in English if the repo keeps both language variants in sync
- `knowledge/CLAUDE.md`
  - rewrite structure examples to use `roles/<role>/` and optional `common/`
  - explain that role-specific `_catalog.md` is now the primary schema/index document
  - mark top-level task docs as deprecated
  - explain that edits require `/mysql-query reload-knowledge` or agent restart
- `config.example.yaml`
  - include `allow_common_knowledge: false`

### 8. Migration

This is a behavior change for knowledge loading.

Migration rules:

- existing account-routing behavior remains unchanged
- existing runtime data access control already remains enforced by role-based account routing inside `executeTool`
- existing top-level `knowledge/<alias>/*.md` task docs stop participating in role-scoped loading
- existing top-level `knowledge/<alias>/_catalog.md` may remain on disk for migration reference, but operators should migrate schema/table/doc-index content into:
  - `knowledge/<alias>/roles/<role>/_catalog.md`
  - optionally `knowledge/<alias>/common/_catalog.md`
- after migrating files, operators should run `/mysql-query reload-knowledge` or restart the agent

No automatic migration is attempted. Operators must restructure knowledge manually because only they know which docs belong to which roles.

Deploy-before-migration behavior:

- visible aliases still appear in the `query` tool description using the generic fallback description
- role-scoped system prompt addendum may be empty for those aliases
- `get_topic_knowledge` denies access for unmigrated role scopes
- `knowledge missing` logs must make this state explicit so operators can distinguish migration lag from authorization problems

### 9. Tests

Required coverage:

- request-aware tool metadata path in zhiliao core passes `RequestContext` through to `getToolDefinitions` and `getSystemPromptAddendum`
- role-specific `query` tool description only lists aliases visible to that role
- role-specific system prompt addendum only includes visible alias/catalog content
- role-specific knowledge resolution loads only `roles/<role>/...`
- `allow_common_knowledge=false` excludes common docs
- `allow_common_knowledge=true` includes common docs
- `get_topic_knowledge` denies docs outside the visible scope
- `executeTool("get_topic_knowledge", ..., context)` must forward `context` into role-scoped knowledge resolution
- role-visible alias computation is centralized in a single helper used by tool metadata and prompts
- missing role knowledge emits `knowledge missing` logs with `hasRoleCatalog` and `reason`
- knowledge resolution success emits `knowledge resolved` logs
- denied knowledge access emits `knowledge denied` logs
- tool descriptions and outputs do not leak usernames or passwords
- aliases with no role account stay hidden even if common knowledge exists
- aliases with only non-default accounts remain valid and are visible only to matching roles
- deploy-before-migration keeps visible aliases queryable with generic descriptions while logging missing knowledge
- `/mysql-query reload-knowledge` swaps in a fully validated snapshot on success
- `/mysql-query reload-knowledge` preserves the previous snapshot on failure

Some of these are regression tests over existing secret filtering and runtime account routing, but they should be kept because this feature changes the prompt and metadata surfaces around those controls.

## Rollout Notes

- Code can ship before all knowledge is migrated, but roles without migrated docs will see reduced knowledge and corresponding `knowledge missing` logs
- This is acceptable and preferable to continuing broad knowledge leakage
- Operators should migrate high-risk roles first, especially ones backed by heavily restricted database accounts
