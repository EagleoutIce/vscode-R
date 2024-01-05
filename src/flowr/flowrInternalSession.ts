import * as vscode from 'vscode';
import {LAST_STEP, NodeId, requestFromInput, RShell, SteppingSlicer} from '@eagleoutice/flowr';
import {SourceRange} from '@eagleoutice/flowr/util/range';
import {isNotUndefined} from '@eagleoutice/flowr/util/assert';

/**
 * Just a proof of concept for now.
 */
export class FlowrInternalSession {
    private readonly outputChannel: vscode.OutputChannel;
    private readonly collection: vscode.DiagnosticCollection;

    constructor(outputChannel: vscode.OutputChannel, collection: vscode.DiagnosticCollection) {
        this.outputChannel = outputChannel;
        this.outputChannel.appendLine(`Using internal FlowR!`);
        this.collection = collection;
    }

    // TODO: caching etc.
    async retrieveSlice(pos: vscode.Position, document: vscode.TextDocument): Promise<string> {
        // TODO: do not use a shell per slice?
        const shell = new RShell();
        shell.tryToInjectHomeLibPath();
        try {
            await this.extractSlice(shell, document, pos);
        } finally {
            shell.close();
        }
        return '';
    }

    private async extractSlice(shell: RShell, document: vscode.TextDocument, pos: vscode.Position) {
        this.outputChannel.appendLine(`Using R shell: ${JSON.stringify(await shell.usedRVersion())}`);
        const filename = document.fileName;
        const content = document.getText();
        const uri = document.uri.with({scheme: 'flowr-diagnostic'});

        const slicer = new SteppingSlicer({
            criterion: [`${pos.line + 1}:${pos.character + 1}`],
            filename,
            shell,
            request: requestFromInput(content),
            stepOfInterest: LAST_STEP
        });
        const result = await slicer.allRemainingSteps();

        // TODO: we should be more robust :D
        const sliceElements = [...result.slice.result].map(id => ({
            id,
            location: result.normalize.idMap.get(id)?.location
        }))
            .filter(e => isNotUndefined(e.location)) as { id: NodeId, location: SourceRange }[];
        // sort by start
        sliceElements.sort((a: { location: SourceRange }, b: { location: SourceRange }) => {
            return a.location.start.line - b.location.start.line || a.location.start.column - b.location.start.column;
        });

        const diagnostics: vscode.Diagnostic[] = [];
        const blockedLines = new Set<number>();
        for (const slice of sliceElements) {
            blockedLines.add(slice.location.start.line - 1);
        }
        for (let i = 0; i < document.lineCount; i++) {
            if (blockedLines.has(i)) {
                continue;
            }
            diagnostics.push({
                message: 'irrelevant for the slice',
                range: new vscode.Range(i, 0, i, document.lineAt(i).text.length),
                severity: vscode.DiagnosticSeverity.Hint,
                tags: [vscode.DiagnosticTag.Unnecessary]
            });
        }
        this.collection.set(uri, diagnostics);
        this.outputChannel.appendLine('slice: ' + JSON.stringify(result.slice.result));
    }
}
