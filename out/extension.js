"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const sqlParser_1 = require("./sqlParser");
const analyzer_1 = require("./analyzer");
const DIAGNOSTIC_SOURCE = 'pg-column-tetris';
const FIX_COMMAND = 'pgColumnTetris.fixTable';
let diagnosticCollection;
let debounceTimer;
function getSeverity() {
    const config = vscode.workspace.getConfiguration('pgColumnTetris');
    switch (config.get('severity', 'warning')) {
        case 'error':
            return vscode.DiagnosticSeverity.Error;
        case 'information':
            return vscode.DiagnosticSeverity.Information;
        case 'hint':
            return vscode.DiagnosticSeverity.Hint;
        case 'warning':
        default:
            return vscode.DiagnosticSeverity.Warning;
    }
}
/**
 * Build a human-readable summary of the optimal column order, used in the
 * diagnostic message and hover tooltip.
 */
function describeOrder(cols) {
    return cols
        .map((c) => {
        const t = c.pgType;
        const sizeStr = t
            ? t.variable
                ? '~variable'
                : `${t.size}B align=${t.align}`
            : 'unknown';
        return `  ${c.name} ${c.type}  -- ${sizeStr}`;
    })
        .join('\n');
}
/**
 * Run the analyzer on a document and publish diagnostics.
 */
function lintDocument(document) {
    if (!isSqlDocument(document)) {
        diagnosticCollection.delete(document.uri);
        return;
    }
    const config = vscode.workspace.getConfiguration('pgColumnTetris');
    if (!config.get('enable', true)) {
        diagnosticCollection.delete(document.uri);
        return;
    }
    const minWasted = config.get('minWastedBytes', 1);
    const severity = getSeverity();
    const text = document.getText();
    const tables = (0, sqlParser_1.parseCreateTables)(text);
    const diagnostics = [];
    for (const table of tables) {
        if (table.columns.length < 2)
            continue;
        const resolved = (0, analyzer_1.resolveColumns)(table.columns);
        const result = (0, analyzer_1.analyzeTable)(resolved);
        if (result.wastedBytes < minWasted)
            continue;
        // Diagnostic spans the table name through the closing paren so the
        // squiggle is informative but doesn't drown the file.
        const start = document.positionAt(table.createOffset);
        // End at the line containing `)` so the squiggle isn't a giant block.
        const tableNameEndOffset = table.openParenOffset;
        const end = document.positionAt(tableNameEndOffset);
        const range = new vscode.Range(start, end);
        const orderPreview = describeOrder(result.optimalOrder);
        const message = `Table "${table.name}" wastes ${result.wastedBytes} bytes per row to ` +
            `alignment padding. Suggested column order:\n\n${orderPreview}`;
        const diag = new vscode.Diagnostic(range, message, severity);
        diag.source = DIAGNOSTIC_SOURCE;
        diag.code = {
            value: 'column-padding',
            target: vscode.Uri.parse('https://www.postgresql.org/docs/current/datatype.html'),
        };
        // Stash fix data for the code-action provider
        const fixData = {
            tableName: table.name,
            openParenOffset: table.openParenOffset,
            closeParenOffset: table.closeParenOffset,
            columnRanges: table.columns.map((c) => ({
                start: c.startOffset,
                end: c.endOffset,
                rawText: c.rawText,
            })),
            optimalRawTexts: result.optimalOrder.map((c) => c.rawText),
        };
        diag.__pgFixData = fixData;
        diagnostics.push(diag);
    }
    diagnosticCollection.set(document.uri, diagnostics);
}
function isSqlDocument(doc) {
    if (doc.languageId === 'sql' || doc.languageId === 'postgres' || doc.languageId === 'mssql')
        return true;
    return doc.uri.fsPath.toLowerCase().endsWith('.sql');
}
/**
 * Apply the optimal column ordering to a table by replacing the body of
 * its column list with the original column-definition text in optimal order.
 *
 * We only touch column lines — table-level constraints (PRIMARY KEY (...)
 * etc.) are preserved by *not* including them in `columnRanges`, which
 * means we leave them untouched at their original offsets... except that
 * a naive replacement would clobber them.
 *
 * Strategy: rebuild the entire column-list body. We collect:
 *   - reordered column definitions (joined by ",\n    ")
 *   - any non-column segments (constraints) kept in original order, appended
 *     after columns
 *
 * For diff-friendliness, we preserve the indentation of the first original
 * column.
 */
function buildReorderEdit(document, fix, fullText) {
    // Re-parse to recover constraints + indentation, since FixData only carries columns.
    const tables = (0, sqlParser_1.parseCreateTables)(fullText);
    const table = tables.find((t) => t.openParenOffset === fix.openParenOffset &&
        t.closeParenOffset === fix.closeParenOffset);
    if (!table)
        return null;
    // Recover the column-list body and its original separators
    const bodyStart = table.openParenOffset + 1;
    const bodyEnd = table.closeParenOffset;
    const body = fullText.slice(bodyStart, bodyEnd);
    // Detect indentation: look at the first column's raw text and the chars
    // immediately preceding it on the same line.
    const firstCol = table.columns[0];
    let indent = '    ';
    if (firstCol) {
        const lineStart = fullText.lastIndexOf('\n', firstCol.startOffset - 1) + 1;
        const before = fullText.slice(lineStart, firstCol.startOffset);
        if (/^\s+$/.test(before))
            indent = before;
    }
    // Find segments that are constraints (not in columnRanges)
    // We need to match the original parser's split. We'll just reuse the parser
    // result: anything *not* a column is a constraint.
    const allSegments = splitTopLevelCommasAware(body);
    const colOffsets = new Set(table.columns.map((c) => c.startOffset - bodyStart));
    const constraints = [];
    for (const seg of allSegments) {
        // Trim leading whitespace to find the actual content offset
        const leadingWs = seg.text.match(/^\s*/)?.[0].length ?? 0;
        const contentOffset = seg.offset + leadingWs;
        if (!colOffsets.has(contentOffset)) {
            const trimmed = seg.text.trim();
            if (trimmed)
                constraints.push(trimmed);
        }
    }
    // Build new body
    const lines = [];
    for (const colText of fix.optimalRawTexts) {
        lines.push(indent + colText.trim());
    }
    for (const cText of constraints) {
        lines.push(indent + cText);
    }
    const newBody = '\n' + lines.join(',\n') + '\n';
    const range = new vscode.Range(document.positionAt(bodyStart), document.positionAt(bodyEnd));
    return vscode.TextEdit.replace(range, newBody);
}
/**
 * Same comma-splitter the parser uses; duplicated here to keep the
 * extension entry point self-contained without re-exporting internals.
 */
function splitTopLevelCommasAware(body) {
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
 * CodeActionProvider that reads stashed FixData off diagnostics and
 * produces a quick-fix that rewrites the table's column order.
 */
class TetrisCodeActionProvider {
    provideCodeActions(document, range, context) {
        const actions = [];
        for (const diag of context.diagnostics) {
            if (diag.source !== DIAGNOSTIC_SOURCE)
                continue;
            const fix = diag.__pgFixData;
            if (!fix)
                continue;
            const action = new vscode.CodeAction(`Reorder columns of "${fix.tableName}" optimally`, vscode.CodeActionKind.QuickFix);
            action.diagnostics = [diag];
            action.isPreferred = true;
            const edit = buildReorderEdit(document, fix, document.getText());
            if (edit) {
                const wsEdit = new vscode.WorkspaceEdit();
                wsEdit.set(document.uri, [edit]);
                action.edit = wsEdit;
            }
            actions.push(action);
        }
        return actions;
    }
}
TetrisCodeActionProvider.providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];
/**
 * Schedule a debounced lint pass (used for onType mode).
 */
function scheduleLint(document, delayMs) {
    if (debounceTimer)
        clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => lintDocument(document), delayMs);
}
function activate(context) {
    diagnosticCollection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
    context.subscriptions.push(diagnosticCollection);
    // Register code-action provider for both sql language IDs
    for (const lang of ['sql', 'postgres', 'mssql']) {
        context.subscriptions.push(vscode.languages.registerCodeActionsProvider({ language: lang, scheme: 'file' }, new TetrisCodeActionProvider(), {
            providedCodeActionKinds: TetrisCodeActionProvider.providedCodeActionKinds,
        }));
    }
    // Lint on open
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(lintDocument));
    // Lint on change / save based on config
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
        const mode = vscode.workspace
            .getConfiguration('pgColumnTetris')
            .get('runOn', 'onType');
        if (mode === 'onType')
            scheduleLint(e.document, 300);
    }));
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((doc) => {
        const mode = vscode.workspace
            .getConfiguration('pgColumnTetris')
            .get('runOn', 'onType');
        if (mode === 'onSave' || mode === 'onType')
            lintDocument(doc);
    }));
    // Clean up diagnostics for closed files
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((doc) => diagnosticCollection.delete(doc.uri)));
    // Lint everything currently open
    vscode.workspace.textDocuments.forEach(lintDocument);
    // ---- Commands ----
    context.subscriptions.push(vscode.commands.registerCommand('pgColumnTetris.checkFile', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No active SQL file.');
            return;
        }
        lintDocument(editor.document);
        const count = diagnosticCollection.get(editor.document.uri)?.length ?? 0;
        vscode.window.showInformationMessage(count === 0
            ? 'PG Column Tetris: no padding issues found.'
            : `PG Column Tetris: ${count} table(s) waste padding.`);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('pgColumnTetris.checkWorkspace', async () => {
        const config = vscode.workspace.getConfiguration('pgColumnTetris');
        const glob = config.get('fileGlob', '**/*.sql');
        const files = await vscode.workspace.findFiles(glob, '**/node_modules/**');
        let totalIssues = 0;
        for (const uri of files) {
            const doc = await vscode.workspace.openTextDocument(uri);
            lintDocument(doc);
            totalIssues += diagnosticCollection.get(uri)?.length ?? 0;
        }
        vscode.window.showInformationMessage(`PG Column Tetris: scanned ${files.length} file(s), found ${totalIssues} issue(s).`);
    }));
    context.subscriptions.push(vscode.commands.registerCommand(FIX_COMMAND, async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const diags = diagnosticCollection.get(editor.document.uri)?.filter((d) => d.range.contains(editor.selection.active)) ?? [];
        if (diags.length === 0) {
            vscode.window.showInformationMessage('PG Column Tetris: no fix available at cursor.');
            return;
        }
        for (const d of diags) {
            const fix = d.__pgFixData;
            if (!fix)
                continue;
            const edit = buildReorderEdit(editor.document, fix, editor.document.getText());
            if (edit) {
                const ws = new vscode.WorkspaceEdit();
                ws.set(editor.document.uri, [edit]);
                await vscode.workspace.applyEdit(ws);
            }
        }
    }));
}
function deactivate() {
    if (debounceTimer)
        clearTimeout(debounceTimer);
    diagnosticCollection?.dispose();
}
//# sourceMappingURL=extension.js.map