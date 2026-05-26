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
- Update knowledge authoring documentation so operators know how to restructure docs

## Non-Goals

- No change to database-side authorization: actual data access is still enforced by the database account
- No change to request role resolution in zhiliao core
- No attempt to infer permissions from table names or SQL text inside the plugin

## Design

### 1. Knowledge Layout

Knowledge remains keyed by configured alias, but the contents become role-scoped.

New layout:

```text
knowledge/
  CLAUDE.md
  <alias>/
    _catalog.md                    # optional alias-level summary only, not schema-rich
    common/
      _catalog.md                  # optional common catalog
      <doc>.md
    roles/
      <role>/
        _catalog.md                # required for role-specific knowledge
        <doc>.md
```

Rules:

- `knowledge/<alias>/roles/<role>/_catalog.md` is the primary catalog for that role
- `knowledge/<alias>/common/_catalog.md` is only considered when `allow_common_knowledge=true`
- top-level `knowledge/<alias>/_catalog.md` remains optional, but only for a one-line alias description and migration compatibility
- top-level role-agnostic task docs under `knowledge/<alias>/*.md` are deprecated and will no longer be loaded into role-scoped prompts

Reasoning:

- If alias-level `_catalog.md` still contains table lists and doc indices, strict isolation is not real
- Putting `_catalog.md` inside `roles/<role>/` keeps schema knowledge and doc indices aligned with the role that can use them

### 2. Config

Add a plugin config flag:

```yaml
allow_common_knowledge: false
```

Semantics:

- default is `false`
- when `false`, only `roles/<role>/...` is visible
- when `true`, the role can read both `roles/<role>/...` and `common/...`

This flag is plugin-wide, not per alias. The simpler model is easier to reason about and matches the user's requirement: strict by default, with one explicit switch for common knowledge.

### 3. Role-Scoped Knowledge Resolution

At runtime, `mysql-query` resolves knowledge using `context.role ?? "default"`.

For a given alias:

1. resolve role-specific catalog and docs from `roles/<role>/`
2. if `allow_common_knowledge=true`, additionally resolve common catalog and docs from `common/`
3. ignore deprecated top-level task docs
4. use alias-level `_catalog.md` only as a fallback alias description, not as schema-rich prompt content

Resolution output for each alias should include:

- `role`
- whether role-specific catalog exists
- whether common catalog exists
- visible docs map
- short alias description for `query` tool description

### 4. query Tool Description Filtering

`query` tool description should only list aliases the current role can query.

Alias visibility is based on account availability:

- visible if `accounts.<role>` exists
- for `role=default` or missing context, visible if `accounts.default` exists
- non-default roles do not fall back to `accounts.default`

The description for each visible alias should come from:

1. role-specific catalog description
2. common catalog description, if allowed
3. alias-level `_catalog.md` description, as a last-resort summary only
4. otherwise, a generic fallback such as `"configured database alias"`

The tool description must not expose:

- usernames
- passwords
- account keys beyond role names already implied by the request context

### 5. get_topic_knowledge Behavior

`get_topic_knowledge` becomes role-aware.

When called with `{ database: <alias>, doc: <doc> }`:

- resolve visible knowledge scopes for `context.role`
- allow docs only from role scope, plus common scope if enabled
- reject docs outside visible scopes

When the requested doc is not visible, return a clear non-sensitive error such as:

`No knowledge document is available for alias "<alias>" under role "<role>".`

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

### 7. Documentation Updates

Implementation must update the knowledge-related docs, not just code.

Required doc updates:

- `README.md`
  - explain role-scoped knowledge layout
  - document `allow_common_knowledge`
  - explain that `query` alias visibility is role-sensitive
- `README_EN.md`
  - same content in English if the repo keeps both language variants in sync
- `knowledge/CLAUDE.md`
  - rewrite structure examples to use `roles/<role>/` and optional `common/`
  - explain that role-specific `_catalog.md` is now the primary schema/index document
  - mark top-level task docs as deprecated
- `config.example.yaml`
  - include `allow_common_knowledge: false`

### 8. Migration

This is a behavior change for knowledge loading.

Migration rules:

- existing account-routing behavior remains unchanged
- existing top-level `knowledge/<alias>/*.md` task docs stop participating in role-scoped loading
- existing top-level `knowledge/<alias>/_catalog.md` may remain as a short alias summary, but operators should migrate schema/table/doc-index content into:
  - `knowledge/<alias>/roles/<role>/_catalog.md`
  - optionally `knowledge/<alias>/common/_catalog.md`

No automatic migration is attempted. Operators must restructure knowledge manually because only they know which docs belong to which roles.

### 9. Tests

Required coverage:

- role-specific `query` tool description only lists aliases visible to that role
- role-specific knowledge resolution loads only `roles/<role>/...`
- `allow_common_knowledge=false` excludes common docs
- `allow_common_knowledge=true` includes common docs
- `get_topic_knowledge` denies docs outside the visible scope
- missing role knowledge emits `knowledge missing` logs with `hasRoleCatalog` and `reason`
- denied knowledge access emits `knowledge denied` logs
- tool descriptions and outputs do not leak usernames or passwords

## Rollout Notes

- Code can ship before all knowledge is migrated, but roles without migrated docs will see reduced knowledge and corresponding `knowledge missing` logs
- This is acceptable and preferable to continuing broad knowledge leakage
- Operators should migrate high-risk roles first, especially ones backed by heavily restricted database accounts
