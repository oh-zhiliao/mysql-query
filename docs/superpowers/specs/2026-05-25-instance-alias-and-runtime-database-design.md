# Instance Alias and Runtime Database Selection Design

## Summary

`mysql-query` currently treats each `known_databases.<key>` entry as both:

- a logical alias for a connection target
- a fixed physical database/schema selected at pool creation time

That model breaks down for role-based accounts such as `ai_complaint`, where one account can access multiple databases on the same Doris/MySQL instance. We need to separate:

- connection alias selection
- runtime physical database selection

without breaking existing callers that still send `database=<alias>`.

## Goals

- Keep the existing config key as the logical alias; do not add another alias layer.
- Allow one configured alias/account pair to query multiple physical databases on the same instance.
- Make the tool contract semantically correct for new callers:
  - `instance` means configured connection alias
  - `database` means physical target database/schema
- Keep backward compatibility for old callers that still send `database` as the alias.
- Keep role-to-account routing and fail-closed behavior for unmapped non-default roles.
- Add code comments explaining the reason for the compatibility path and runtime database selection model.
- Keep runtime semantics deterministic and safe under pooling; no connection state bleed between databases.

## Non-Goals

- No plugin-side `allowed_databases` list. Database access control remains entirely in the database account's own privileges.
- No multi-role merge logic.
- No automatic migration of deployment config files.
- No immediate knowledge directory layout migration to `instance/database/...`.

## Current Problem

Today the plugin config and tool contract both overload `database`:

- config `known_databases.doris.database` means the fixed physical default database
- tool input `database` means the configured alias

That prevents this valid use case:

- alias `doris`
- role `complaint`
- account `ai_complaint`
- physical database selected at query time: `wizard`, `eggtart`, `conf`, etc.

The plugin should let the caller choose the physical database at execution time, while still reusing the same connection/account routing.

## Proposed Model

### Config Model

Keep the existing top-level structure and key semantics:

```yaml
known_databases:
  doris:
    host: "1.13.127.79"
    port: 9030
    database: "doris"   # optional default physical database
    accounts:
      default:
        user: "..."
        password: "..."
      complaint:
        user: "..."
        password: "..."
```

Rules:

- `known_databases.<key>` remains the configured alias.
- `database` becomes optional.
- If present, `database` is only the default physical database for queries that do not specify one explicitly.
- Role-based account selection remains unchanged:
  - no `context.role` => use `accounts.default`
  - mapped `context.role` => use `accounts[role]`
  - unmapped non-default role => reject

### Query Tool Contract

New preferred input shape:

```json
{
  "instance": "doris",
  "database": "wizard",
  "sql": "SELECT ...",
  "limit": 100
}
```

Compatibility input shape:

```json
{
  "database": "doris",
  "sql": "SELECT ...",
  "limit": 100
}
```

New tool JSON schema:

- `required: ["sql"]`
- `instance?: string`
- `database?: string`
- `sql: string`
- `limit?: number`

Validation rules:

- reject if both `instance` and `database` are absent
- when `instance` is present, `database` means the physical target database
- when `instance` is absent, `database` is first interpreted as the legacy alias input
- if a physical database name is resolved from user input, it must match a strict identifier pattern such as `^[A-Za-z0-9_]+$`

Resolution rules:

1. If both `instance` and `database` are absent, reject with a clear error.
2. If `instance` is present, treat it as the alias.
3. If `instance` is absent and `database` is present, treat `database` as the legacy alias input.
4. Determine the physical target database:
   - explicit `input.database` when `instance` is present
   - otherwise config default `known_databases[instance].database`
5. If neither an explicit physical database nor a config default exists, reject with a clear error before pool creation.

This makes new usage semantically correct while preserving old callers.

### Knowledge Tool Contract

`get_topic_knowledge` keeps its current external behavior for now:

```json
{
  "database": "doris",
  "doc": "orders"
}
```

Interpretation:

- `database` here still means the configured alias, not the physical schema name

Rationale:

- knowledge is still organized under `knowledge/<alias>/...`
- changing both query and knowledge contracts in one step adds unnecessary migration complexity

This asymmetry is acceptable temporarily and must be documented in the tool descriptions and comments.

## Execution Semantics

### Pooling

Pools should be keyed by:

- configured alias
- resolved account key / role
- resolved physical database

Rationale:

- a pool represents a connection/account route to one instance
- physical database selection is still a per-query input concern, but the resolved database must participate in the pool key to avoid session-state bleed across pooled connections
- database privileges are enforced by the account, not by the plugin's pool key
- the pool key is an isolation mechanism, not a permission boundary

### Physical Database Selection

At query execution time:

1. resolve alias
2. resolve role/account
3. resolve target physical database
4. execute the query under that database context

Implementation expectation:

- resolve the target physical database before any pool lookup
- validate the resolved physical database name against a strict identifier rule before using it
- create or reuse a pool keyed by `(alias, account, resolved_database)`
- set the resolved physical database in the connection options for that pool

The implementation must not rely on issuing raw `USE <database>` SQL as the primary switching mechanism. That approach is too easy to get wrong under pooled connections and complicates injection safety. The resolved-database pool key is the chosen design for this phase.

## Backward Compatibility

This is not a hard breaking change in the next release.

Compatibility policy:

- old query callers remain supported
- phase 1 descriptions should state that `instance + optional database` is preferred, while explicitly noting that legacy `database=<alias>` is still accepted
- old-style `database=<alias>` remains accepted but is treated as deprecated

The code must contain short comments explaining:

- why both `instance` and legacy `database` are accepted
- why legacy `database` is interpreted as an alias in compatibility mode
- why the physical database is resolved separately at runtime

These comments are required because the compatibility path will otherwise look inconsistent or accidental.

## Logging and Output

Query summaries and debug-oriented output should make the distinction explicit:

- `instance=<alias>`
- `database=<physical database actually used>`
- `mode=legacy` when the compatibility path was used

This applies to:

- `summarizeInput(...)`
- SQL result header block
- any compatibility-path diagnostic logging added during implementation

The goal is to remove ambiguity during debugging without leaking secrets.

## Error Behavior

Required errors:

- unknown alias
- unmapped non-default role
- invalid physical database name
- both `instance` and `database` absent
- no target physical database provided and no config default exists
- runtime database access denied by the database server

Database privilege failures should be surfaced as normal query errors. The plugin should not try to predict or duplicate server-side database authorization.

## Knowledge Model

Keep knowledge loading unchanged for this phase:

- `knowledge/<alias>/_catalog.md`
- `knowledge/<alias>/<doc>.md`

Catalog guidance should be updated to mention:

- default physical database if one exists
- common alternative physical databases on the same instance when relevant

Future follow-up is possible if alias-level knowledge becomes too coarse, but that is not part of this change.

## Testing Requirements

The implementation plan must cover at least:

- new query input using `instance + database`
- new query input using `instance` only and falling back to config default database
- legacy query input using `database=<alias>` and config default present
- legacy query input using `database=<alias>` and config default missing => clear error
- both `instance` and `database` absent => clear error
- invalid physical database name => clear error
- missing explicit database plus missing config default => clear error
- role-based account resolution still working with the new alias semantics
- one role/account querying different physical databases on the same alias
- no bleed between queries selecting different physical databases
- summaries/result headers reflecting both alias and actual physical database, plus a legacy marker when compatibility mode is used
- knowledge tool remaining alias-based

## Migration Impact

For users:

- no immediate query-tool break if they still use legacy `database=<alias>`
- new usage should move to `instance + database?`

For deployers:

- no new `allowed_databases` config to maintain
- existing role-account config remains valid
- `database` in config becomes optional rather than mandatory

## Recommended Implementation Direction

Implement in two layers:

1. query contract, schema updates, runtime database resolution, and resolved-database pool isolation
2. docs/tests/comment updates for compatibility and knowledge guidance

Do not change knowledge directory layout in the same patch series.
