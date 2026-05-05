/**
 * Padding & ordering analyzer.
 *
 * Simulates how Postgres lays out a tuple given a column order, accounting
 * for per-type alignment. Computes:
 *
 *   - bytes wasted to padding in the current order
 *   - an optimal ordering that minimizes (and ideally eliminates) padding
 *   - bytes wasted in that optimal order
 *
 * Tuple layout assumptions (64-bit, MAXALIGN = 8):
 *   - Per-row header is 23 bytes, with the first datum starting at offset
 *     24 (1 byte of trailing pad — but this is fixed and unaffected by
 *     column order, so we model column data starting at offset 0 since
 *     all reorderings see the same header).
 *   - For each column we add `padding_to_align(currentOffset, col.align)`
 *     bytes, then the column's size (variable-length columns are treated
 *     as having align=4 and counted with size 0 — only their alignment
 *     padding is real).
 *   - At the end, the total tuple size is rounded up to MAXALIGN for the
 *     next row. We do not count this final pad against the column ordering
 *     because every ordering pays the same final-MAXALIGN tax up to 7 bytes,
 *     and it can be 0.  We *do* compare it between orderings when scoring.
 */

import { ParsedColumn } from './sqlParser';
import { PgType, resolveType } from './pgTypes';

export interface ResolvedColumn extends ParsedColumn {
  pgType: PgType | null;
}

export interface LayoutResult {
  /** Total bytes used (excluding fixed row header) by this ordering */
  totalBytes: number;
  /** Bytes spent on inter-column padding */
  paddingBytes: number;
  /** Bytes spent on final MAXALIGN tail padding */
  tailPaddingBytes: number;
}

const MAXALIGN = 8;

/** Bytes of padding needed before placing a value with `align` at `offset`. */
function padTo(offset: number, align: number): number {
  if (align <= 1) return 0;
  const rem = offset % align;
  return rem === 0 ? 0 : align - rem;
}

/**
 * Simulate the layout of the given columns in order.
 *
 * Variable-length columns (size = -1) contribute alignment padding but their
 * actual byte count is data-dependent — we conservatively model them as
 * occupying 0 bytes for the *padding* analysis, since the user cares about
 * column ordering, not estimating real row size. The penalty we minimize is
 * padding-only.
 */
export function simulateLayout(cols: ResolvedColumn[]): LayoutResult {
  let offset = 0;
  let padding = 0;

  for (const col of cols) {
    const t = col.pgType;
    if (!t) continue; // unknown types contribute nothing to the analysis
    const pad = padTo(offset, t.align);
    padding += pad;
    offset += pad;
    if (t.size > 0) {
      offset += t.size;
    } else {
      // Variable-length: assume the user has data, advance by the varlena
      // header (4 bytes) so subsequent fixed-aligned columns don't get
      // "free" alignment from a zero-size assumption. In practice users
      // put varlenas last, so this rarely matters.
      offset += 4;
    }
  }

  const tail = padTo(offset, MAXALIGN);
  return {
    totalBytes: offset + tail,
    paddingBytes: padding,
    tailPaddingBytes: tail,
  };
}

/**
 * Resolve raw parsed columns into `ResolvedColumn` with PgType metadata.
 */
export function resolveColumns(cols: ParsedColumn[]): ResolvedColumn[] {
  return cols.map((c) => ({ ...c, pgType: resolveType(c.type) }));
}

/**
 * Compute the optimal column ordering to minimize alignment padding.
 *
 * Strategy (matches the well-known "column tetris" rules of thumb,
 * specifically GitLab's documented algorithm and pg_column_byte_packer):
 *
 *   1. Place fixed-length columns sorted by alignment DESC, then size DESC.
 *      This naturally puts 8-byte-aligned types first, then 4, 2, 1.
 *   2. Place variable-length columns last (their alignment is 4 but their
 *      effective size is unknown; ordering among themselves doesn't matter
 *      for padding).
 *   3. Unknown types (custom domains, enums, user types) are kept in their
 *      original relative position at the end of the fixed group — we can't
 *      safely reorder around them without knowing their alignment.
 *
 * Stable across ties (preserves original order) so the result is predictable
 * and minimizes diff churn when applying the auto-fix.
 */
export function optimalOrder(cols: ResolvedColumn[]): ResolvedColumn[] {
  const fixed: ResolvedColumn[] = [];
  const variable: ResolvedColumn[] = [];
  const unknown: ResolvedColumn[] = [];

  cols.forEach((c, idx) => {
    (c as any).__origIdx = idx;
    if (!c.pgType) unknown.push(c);
    else if (c.pgType.variable) variable.push(c);
    else fixed.push(c);
  });

  // Sort fixed columns by align DESC, then size DESC, stable on original index.
  fixed.sort((a, b) => {
    const aT = a.pgType!;
    const bT = b.pgType!;
    if (bT.align !== aT.align) return bT.align - aT.align;
    if (bT.size !== aT.size) return bT.size - aT.size;
    return (a as any).__origIdx - (b as any).__origIdx;
  });

  // Variable-length columns: keep original relative order
  variable.sort((a, b) => (a as any).__origIdx - (b as any).__origIdx);

  // Unknown: keep at end in original order (safest)
  unknown.sort((a, b) => (a as any).__origIdx - (b as any).__origIdx);

  return [...fixed, ...variable, ...unknown];
}

export interface AnalysisResult {
  current: LayoutResult;
  optimal: LayoutResult;
  optimalOrder: ResolvedColumn[];
  /** True if the current order already wastes no inter-column padding */
  isOptimal: boolean;
  /** Bytes per row that could be saved by reordering */
  wastedBytes: number;
}

/**
 * Full analysis: how much room for improvement does the current order have?
 *
 * "Wasted bytes" is defined as the difference in total tuple size between
 * the current order and the optimal order. This is the actually meaningful
 * number — it's how many bytes per row Postgres would save if you reordered.
 *
 * (Earlier versions compared padding-vs-padding, which incorrectly reported
 * zero waste in cases where reordering *moved* padding from inter-column to
 * tail without reducing total size — but Postgres still pays for both.
 * Comparing total tuple size is what matches reality.)
 *
 * Additionally, we report inter-column padding wasted in the *current* order
 * so even when the total-size comparison says "tied," users with sandwiched
 * narrow types between wide ones still get a hint.
 */
export function analyzeTable(cols: ResolvedColumn[]): AnalysisResult {
  const current = simulateLayout(cols);
  const opt = optimalOrder(cols);
  const optimal = simulateLayout(opt);

  // Primary metric: actual size reduction reordering would produce
  const sizeReduction = Math.max(0, current.totalBytes - optimal.totalBytes);

  // Secondary signal: inter-column padding present in current order that
  // the optimal order avoids. This catches the (boolean, bigint) case
  // where total size is unchanged but the bad order leaves an obvious
  // 7-byte hole between columns that the good order doesn't have.
  const interColPaddingDelta = Math.max(
    0,
    current.paddingBytes - optimal.paddingBytes,
  );

  const wastedBytes = Math.max(sizeReduction, interColPaddingDelta);

  return {
    current,
    optimal,
    optimalOrder: opt,
    isOptimal: wastedBytes === 0,
    wastedBytes,
  };
}