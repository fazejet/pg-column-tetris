"use strict";
/**
 * Lightweight CREATE TABLE parser.
 *
 * Not a full SQL grammar — just enough to find `CREATE TABLE` statements,
 * pull out column definitions, and locate them in source for diagnostics
 * and edits. Skips constraints and table-level clauses.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCreateTables = parseCreateTables;
/**
 * Strip SQL comments (`-- line` and slash-star block) while preserving offsets
 * so positions reported back map to the original source. Replaced characters
 * become spaces (or newlines) so the parser sees a comment-free buffer of
 * identical length.
 */
function stripComments(sql) {
    const out = sql.split('');
    let i = 0;
    while (i < out.length) {
        const c = out[i];
        const next = out[i + 1];
        // String literal — skip over it
        if (c === "'") {
            out[i] = "'"; // keep
            i++;
            while (i < out.length && out[i] !== "'") {
                if (out[i] === '\\' && i + 1 < out.length)
                    i++; // skip escaped
                i++;
            }
            i++; // closing quote
            continue;
        }
        // Quoted identifier
        if (c === '"') {
            i++;
            while (i < out.length && out[i] !== '"')
                i++;
            i++;
            continue;
        }
        // Line comment
        if (c === '-' && next === '-') {
            while (i < out.length && out[i] !== '\n') {
                out[i] = ' ';
                i++;
            }
            continue;
        }
        // Block comment
        if (c === '/' && next === '*') {
            while (i < out.length && !(out[i] === '*' && out[i + 1] === '/')) {
                if (out[i] !== '\n')
                    out[i] = ' ';
                i++;
            }
            if (i < out.length) {
                out[i] = ' ';
                out[i + 1] = ' ';
                i += 2;
            }
            continue;
        }
        i++;
    }
    return out.join('');
}
/**
 * Find the matching closing paren for the `(` at `openIdx` in `s`.
 * Respects string literals and quoted identifiers. Returns -1 if unmatched.
 */
function findMatchingParen(s, openIdx) {
    let depth = 0;
    let i = openIdx;
    while (i < s.length) {
        const c = s[i];
        if (c === "'") {
            i++;
            while (i < s.length && s[i] !== "'") {
                if (s[i] === '\\')
                    i++;
                i++;
            }
            i++;
            continue;
        }
        if (c === '"') {
            i++;
            while (i < s.length && s[i] !== '"')
                i++;
            i++;
            continue;
        }
        if (c === '(')
            depth++;
        else if (c === ')') {
            depth--;
            if (depth === 0)
                return i;
        }
        i++;
    }
    return -1;
}
/**
 * Split a column-list body on top-level commas (ignoring commas inside
 * parentheses such as `numeric(10, 2)`).
 *
 * Returns segments together with their offset within the body.
 */
function splitTopLevelCommas(body) {
    const segments = [];
    let depth = 0;
    let segStart = 0;
    let i = 0;
    while (i < body.length) {
        const c = body[i];
        if (c === "'") {
            i++;
            while (i < body.length && body[i] !== "'") {
                if (body[i] === '\\')
                    i++;
                i++;
            }
            i++;
            continue;
        }
        if (c === '"') {
            i++;
            while (i < body.length && body[i] !== '"')
                i++;
            i++;
            continue;
        }
        if (c === '(')
            depth++;
        else if (c === ')')
            depth--;
        else if (c === ',' && depth === 0) {
            segments.push({ text: body.slice(segStart, i), offset: segStart });
            segStart = i + 1;
        }
        i++;
    }
    if (segStart < body.length) {
        segments.push({ text: body.slice(segStart), offset: segStart });
    }
    return segments;
}
/**
 * Detect whether a column-list segment is a table-level constraint
 * (PRIMARY KEY, FOREIGN KEY, UNIQUE, CHECK, EXCLUDE, CONSTRAINT, LIKE)
 * rather than a column definition.
 */
function isTableConstraint(segment) {
    const trimmed = segment.trim().toUpperCase();
    return (trimmed.startsWith('PRIMARY KEY') ||
        trimmed.startsWith('FOREIGN KEY') ||
        trimmed.startsWith('UNIQUE') ||
        trimmed.startsWith('CHECK') ||
        trimmed.startsWith('EXCLUDE') ||
        trimmed.startsWith('CONSTRAINT ') ||
        trimmed.startsWith('LIKE '));
}
/**
 * Split a column definition into its name and type. Handles:
 *   user_id BIGINT NOT NULL
 *   "weird name" VARCHAR(255)
 *   created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
 *   amount NUMERIC(10, 2)
 *
 * Returns null if the segment doesn't look like a column.
 */
function parseColumnDef(segment) {
    const trimmed = segment.trim();
    if (!trimmed)
        return null;
    // Extract name: quoted identifier or bare word
    let nameEnd;
    let name;
    if (trimmed.startsWith('"')) {
        const close = trimmed.indexOf('"', 1);
        if (close < 0)
            return null;
        name = trimmed.slice(0, close + 1);
        nameEnd = close + 1;
    }
    else {
        const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(trimmed);
        if (!m)
            return null;
        name = m[0];
        nameEnd = m[0].length;
    }
    // Skip whitespace after name
    let i = nameEnd;
    while (i < trimmed.length && /\s/.test(trimmed[i]))
        i++;
    // Type runs from here until we hit a column constraint keyword or the end.
    // Column constraints: NOT NULL, NULL, DEFAULT, PRIMARY, UNIQUE, REFERENCES,
    // CHECK, GENERATED, COLLATE, CONSTRAINT
    const stopKeywords = [
        'NOT NULL',
        'NULL',
        'DEFAULT',
        'PRIMARY',
        'UNIQUE',
        'REFERENCES',
        'CHECK',
        'GENERATED',
        'COLLATE',
        'CONSTRAINT',
    ];
    const rest = trimmed.slice(i);
    const upperRest = rest.toUpperCase();
    let typeEnd = rest.length;
    let depth = 0;
    let j = 0;
    while (j < rest.length) {
        const c = rest[j];
        if (c === '(') {
            depth++;
            j++;
            continue;
        }
        if (c === ')') {
            depth--;
            j++;
            continue;
        }
        if (depth === 0) {
            // Check stop keywords on word boundary
            const before = j === 0 ? ' ' : rest[j - 1];
            if (/\s/.test(before) || j === 0) {
                for (const kw of stopKeywords) {
                    if (upperRest.startsWith(kw, j) &&
                        (j + kw.length === rest.length ||
                            /[\s(]/.test(rest[j + kw.length]))) {
                        typeEnd = j;
                        j = rest.length;
                        break;
                    }
                }
            }
        }
        j++;
    }
    const type = rest.slice(0, typeEnd).trim();
    if (!type)
        return null;
    return { name, type };
}
/**
 * Extract the name following CREATE TABLE [IF NOT EXISTS] [schema.]name.
 * Returns the bare name (last segment) and the offset of `(` in source.
 */
function parseTableHeader(source, createIdx) {
    // Skip past CREATE  [TEMP|TEMPORARY|UNLOGGED]?  TABLE  [IF NOT EXISTS]?  name (
    const headerRe = /CREATE\s+(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_"][\w".]*)\s*\(/iy;
    headerRe.lastIndex = createIdx;
    const m = headerRe.exec(source);
    if (!m)
        return null;
    let name = m[1];
    // Strip schema and quotes for display
    const segs = name.split('.');
    name = segs[segs.length - 1];
    if (name.startsWith('"') && name.endsWith('"')) {
        name = name.slice(1, -1);
    }
    const openParenOffset = headerRe.lastIndex - 1; // last char matched is `(`
    return { tableName: name, openParenOffset };
}
/**
 * Parse all CREATE TABLE statements out of an SQL source buffer.
 */
function parseCreateTables(originalSource) {
    const source = stripComments(originalSource);
    const tables = [];
    // Find each CREATE TABLE keyword run
    const createRe = /\bCREATE\s+(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)?TABLE\b/gi;
    let m;
    while ((m = createRe.exec(source)) !== null) {
        const createOffset = m.index;
        const header = parseTableHeader(source, createOffset);
        if (!header)
            continue;
        const close = findMatchingParen(source, header.openParenOffset);
        if (close < 0)
            continue;
        const body = source.slice(header.openParenOffset + 1, close);
        const bodyStart = header.openParenOffset + 1;
        const segments = splitTopLevelCommas(body);
        const columns = [];
        for (const seg of segments) {
            if (isTableConstraint(seg.text))
                continue;
            const parsed = parseColumnDef(seg.text);
            if (!parsed)
                continue;
            // Compute precise offsets in the original source
            // (offsets in the comment-stripped buffer match original since we replaced
            // comments with spaces.)
            const segStartInSource = bodyStart + seg.offset;
            const leadingWs = seg.text.match(/^\s*/)?.[0].length ?? 0;
            const trailingWs = seg.text.match(/\s*$/)?.[0].length ?? 0;
            const startOffset = segStartInSource + leadingWs;
            const endOffset = segStartInSource + seg.text.length - trailingWs;
            columns.push({
                name: parsed.name,
                type: parsed.type,
                rawText: originalSource.slice(startOffset, endOffset),
                startOffset,
                endOffset,
            });
        }
        tables.push({
            name: header.tableName,
            createOffset,
            openParenOffset: header.openParenOffset,
            closeParenOffset: close,
            columns,
        });
        // Continue scanning after this table
        createRe.lastIndex = close + 1;
    }
    return tables;
}
//# sourceMappingURL=sqlParser.js.map