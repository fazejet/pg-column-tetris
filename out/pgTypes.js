"use strict";
/**
 * PostgreSQL type alignment & size table.
 *
 * Sourced from `pg_type.typalign` / `typlen` in the catalog. Values match a
 * 64-bit Postgres install (the overwhelming majority of deployments).
 *
 *   typalign:  c=1 byte, s=2 bytes, i=4 bytes, d=8 bytes
 *   typlen  : -1 = variable length (varlena, e.g. text, varchar, numeric)
 *             -2 = cstring
 *
 * Variable-length types are stored with a 4-byte varlena header and are
 * aligned to 4 bytes. For padding-calculation purposes we treat them as
 * having align=4 and place them at the end (their actual size depends on
 * the data, not the schema).
 *
 * UUID is the notable special case: typlen=16 but typalign=c (1 byte).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PG_TYPES = void 0;
exports.resolveType = resolveType;
/**
 * Map normalized type names to their alignment metadata.
 *
 * Type names should be looked up after stripping parameters
 * (e.g. `varchar(255)` → `varchar`) and lowercasing.
 */
exports.PG_TYPES = {
    // ---- 8-byte, 8-byte aligned ----
    bigint: { align: 8, size: 8, variable: false },
    int8: { align: 8, size: 8, variable: false },
    bigserial: { align: 8, size: 8, variable: false },
    serial8: { align: 8, size: 8, variable: false },
    'double precision': { align: 8, size: 8, variable: false },
    float8: { align: 8, size: 8, variable: false },
    timestamp: { align: 8, size: 8, variable: false },
    'timestamp without time zone': { align: 8, size: 8, variable: false },
    'timestamp with time zone': { align: 8, size: 8, variable: false },
    timestamptz: { align: 8, size: 8, variable: false },
    'time with time zone': { align: 8, size: 12, variable: false }, // 12 bytes, 8-byte aligned
    timetz: { align: 8, size: 12, variable: false },
    interval: { align: 8, size: 16, variable: false },
    money: { align: 8, size: 8, variable: false },
    // ---- 4-byte, 4-byte aligned ----
    integer: { align: 4, size: 4, variable: false },
    int: { align: 4, size: 4, variable: false },
    int4: { align: 4, size: 4, variable: false },
    serial: { align: 4, size: 4, variable: false },
    serial4: { align: 4, size: 4, variable: false },
    real: { align: 4, size: 4, variable: false },
    float4: { align: 4, size: 4, variable: false },
    date: { align: 4, size: 4, variable: false },
    'time without time zone': { align: 8, size: 8, variable: false },
    time: { align: 8, size: 8, variable: false },
    oid: { align: 4, size: 4, variable: false },
    // ---- 2-byte, 2-byte aligned ----
    smallint: { align: 2, size: 2, variable: false },
    int2: { align: 2, size: 2, variable: false },
    smallserial: { align: 2, size: 2, variable: false },
    serial2: { align: 2, size: 2, variable: false },
    // ---- 1-byte, 1-byte aligned ----
    boolean: { align: 1, size: 1, variable: false },
    bool: { align: 1, size: 1, variable: false },
    '"char"': { align: 1, size: 1, variable: false },
    char: { align: 1, size: 1, variable: false }, // single-byte internal char
    // ---- Special: UUID is 16 bytes but alignment 1 (typalign='c') ----
    uuid: { align: 1, size: 16, variable: false },
    // ---- 8-byte aligned, larger fixed ----
    macaddr8: { align: 4, size: 8, variable: false },
    macaddr: { align: 4, size: 6, variable: false },
    // ---- Variable-length (4-byte aligned, varlena header) ----
    text: { align: 4, size: -1, variable: true },
    varchar: { align: 4, size: -1, variable: true },
    'character varying': { align: 4, size: -1, variable: true },
    bpchar: { align: 4, size: -1, variable: true },
    character: { align: 4, size: -1, variable: true },
    bytea: { align: 4, size: -1, variable: true },
    numeric: { align: 4, size: -1, variable: true },
    decimal: { align: 4, size: -1, variable: true },
    json: { align: 4, size: -1, variable: true },
    jsonb: { align: 4, size: -1, variable: true },
    xml: { align: 4, size: -1, variable: true },
    cidr: { align: 4, size: -1, variable: true },
    inet: { align: 4, size: -1, variable: true },
    tsvector: { align: 4, size: -1, variable: true },
    tsquery: { align: 4, size: -1, variable: true },
    // ---- Geometric (8-byte aligned, fixed) ----
    point: { align: 8, size: 16, variable: false },
    line: { align: 8, size: 24, variable: false },
    lseg: { align: 8, size: 32, variable: false },
    box: { align: 8, size: 32, variable: false },
    circle: { align: 8, size: 24, variable: false },
    // ---- Bit strings (variable) ----
    bit: { align: 4, size: -1, variable: true },
    varbit: { align: 4, size: -1, variable: true },
    'bit varying': { align: 4, size: -1, variable: true },
};
/**
 * Resolve a raw column type string from SQL into PgType metadata.
 *
 * Handles parameterized types like `varchar(255)`, `numeric(10,2)`,
 * arrays (`integer[]`), and qualified names (`pg_catalog.int4`).
 * Returns `null` for unknown types (custom domains, enums, etc.).
 */
function resolveType(rawType) {
    if (!rawType)
        return null;
    let t = rawType.trim().toLowerCase();
    // Strip schema qualification: pg_catalog.int4 -> int4
    const dotIdx = t.lastIndexOf('.');
    if (dotIdx >= 0)
        t = t.slice(dotIdx + 1);
    // Arrays — varlena, 4-byte aligned, variable
    if (t.endsWith('[]') || /\barray\b/.test(t)) {
        return { align: 4, size: -1, variable: true };
    }
    // Strip parameters: varchar(255) -> varchar, numeric(10,2) -> numeric
    const parenIdx = t.indexOf('(');
    if (parenIdx >= 0)
        t = t.slice(0, parenIdx).trim();
    // Collapse whitespace for multi-word types
    t = t.replace(/\s+/g, ' ');
    return exports.PG_TYPES[t] ?? null;
}
//# sourceMappingURL=pgTypes.js.map