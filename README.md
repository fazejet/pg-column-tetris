# PG Column Tetris (VS Code)

A VS Code extension that lints PostgreSQL migration files for column ordering that wastes disk space due to alignment padding, and offers a one-click auto-fix to reorder columns optimally.

This is a static-analysis port of the [`pg_column_tetris`](https://github.com/rogerwelin/pg_column_tetris) Postgres extension by Roger Welin. The original runs inside Postgres and inspects live tables; this version inspects your `.sql` migration files **as you write them**, so you catch issues before they ever ship.

## Why column order matters

Postgres lays each row out in memory in declaration order, with padding inserted before each column to satisfy the alignment requirement of its data type. A poorly ordered table can waste 20-40% of its row size on padding. This is a well-known optimization technique, sometimes called "column tetris" — see Erwin Brandstetter's [Stack Overflow answer](https://stackoverflow.com/a/7431468) and [PayPal's `pg_column_byte_packer`](https://medium.com/paypal-tech/postgresql-at-scale-saving-space-basically-for-free-d94483d9ed9a).

For example:

```sql
CREATE TABLE users (
  flag       BOOLEAN,    -- 1 byte
  big_id     BIGINT,     -- 8 bytes (forces 7 bytes of padding before it)
  n          INTEGER     -- 4 bytes
);
-- Per row: 24 (header) + 1 + 7 pad + 8 + 4 + 4 tail pad = 48 bytes
```

vs.

```sql
CREATE TABLE users (
  big_id     BIGINT,     -- 8 bytes, aligned naturally
  n          INTEGER,    -- 4 bytes
  flag       BOOLEAN     -- 1 byte
);
-- Per row: 24 (header) + 8 + 4 + 1 + 3 tail pad = 40 bytes
```

That's 8 bytes per row saved. On a 100M-row table, ~800 MB.

## Features

- **On-the-fly diagnostics.** Underlines `CREATE TABLE` statements that waste padding, with a hover that explains how many bytes per row are wasted and shows the suggested column order.
- **Quick-fix auto-reorder.** Press `Ctrl+.` (or `Cmd+.`) on a flagged table to apply the optimal ordering. Table-level constraints (`PRIMARY KEY`, `CONSTRAINT`, `CHECK`, etc.) are preserved.
- **Workspace-wide scan.** Run `PG Column Tetris: Check All Migration Files` from the command palette to lint every `.sql` file in your project.
- **Configurable.** Set the severity (warning/error/info), the minimum bytes to report, the file glob, and whether to lint on type, on save, or only on demand.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `pgColumnTetris.enable` | `true` | Master on/off switch. |
| `pgColumnTetris.severity` | `warning` | `error`, `warning`, `information`, or `hint`. |
| `pgColumnTetris.minWastedBytes` | `1` | Don't report tables wasting fewer than this many bytes per row. |
| `pgColumnTetris.fileGlob` | `**/*.sql` | Pattern for the workspace scan. |
| `pgColumnTetris.runOn` | `onType` | `onType`, `onSave`, or `manual`. |

## How the analyzer works

1. **Parse.** A focused recursive-descent parser finds every `CREATE TABLE` statement, including `IF NOT EXISTS`, schema-qualified names, and quoted identifiers. Table-level constraints are detected and excluded from the column list. SQL comments and string literals are correctly skipped.
2. **Resolve types.** Each column's type is matched against a table of PostgreSQL type alignment data (`pg_type.typalign` / `typlen` for a 64-bit install). Parameterized types like `varchar(255)` and `numeric(10, 2)` are stripped to their base. Arrays and unknown user-defined types are handled conservatively.
3. **Simulate layout.** The analyzer walks the columns in declaration order, inserting alignment padding before each, mirroring how Postgres actually lays out a tuple.
4. **Compute optimal order.** Fixed-length columns are sorted by alignment descending then size descending (stably, so ties don't cause noisy diffs). Variable-length columns (`text`, `varchar`, `numeric`, `jsonb`, etc.) go last. Unknown types stay in their original relative position.
5. **Report.** If the optimal layout would save bytes, a diagnostic is emitted with the byte count and a suggested column order. The quick-fix rewrites the column list while preserving constraints, indentation, and column-level modifiers like `NOT NULL` and `DEFAULT`.

## Limitations

- Custom domains, enums, and other user-defined types have unknown alignment. The analyzer skips them in padding calculations and keeps them in their original position when reordering.
- The analyzer assumes a 64-bit Postgres install (the overwhelming majority). On 32-bit systems, MAXALIGN is 4 instead of 8 and some numbers will differ slightly.
- Variable-length columns (`text`, `numeric`, etc.) have data-dependent storage size; the analyzer accounts for their alignment but not their stored bytes, which is the correct behavior for column-ordering analysis.
- Indexes, `ALTER TABLE`, and `CREATE TABLE ... AS` are not analyzed. The original `pg_column_tetris` operates on existing tables in the database; for those, install the original extension.

## Installation

This extension isn't published to the Marketplace — it's distributed as a `.vsix` file for internal team use. To install:

1. Grab the latest `pg-column-tetris-<version>.vsix` from the repo (or wherever the team shares it).
2. Install it from the command line:

   ```bash
   code --install-extension pg-column-tetris-0.1.0.vsix
   ```

   Or in VS Code: open the Extensions view, click the `…` menu, and choose **Install from VSIX…**.
3. Reload VS Code if prompted.

## Building from source

```bash
npm install
npm run compile
# then F5 in VS Code to launch a development host
```

To produce a `.vsix` for distribution:

```bash
npx @vscode/vsce package
```

## License

MIT.
