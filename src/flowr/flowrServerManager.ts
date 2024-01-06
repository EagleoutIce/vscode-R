import * as net from 'net';
import * as vscode from 'vscode';
import { FlowrMessage } from '@eagleoutice/flowr/cli/repl';
import { FileAnalysisResponseMessageJson } from '@eagleoutice/flowr/cli/repl/server/messages/analysis';
import { SliceResponseMessage } from '@eagleoutice/flowr/cli/repl/server/messages/slice';
import { NodeId, visitAst } from '@eagleoutice/flowr';
import { SourceRange } from '@eagleoutice/flowr/util/range';
import { isNotUndefined } from '@eagleoutice/flowr/util/assert';
import { FlowrInternalSession } from './flowrInternalSession';

/**
 * Just a proof of concept for now.
 */
export class FlowRServerSession {
    private readonly port: number;
    private readonly host: string;
    private readonly outputChannel: vscode.OutputChannel;
    private readonly collection: vscode.DiagnosticCollection;
    private socket: net.Socket;
    private idCounter = 0;

    constructor(outputChannel: vscode.OutputChannel, collection: vscode.DiagnosticCollection, port = 1042, host = 'localhost') {
        this.port = port;
        this.host = host;
        this.outputChannel = outputChannel;
        this.outputChannel.appendLine(`Connecting to FlowR server at ${host}:${port}`);
        this.socket = net.createConnection(this.port, this.host, () => {
            this.outputChannel.appendLine('Connected to FlowR server!');
        });
        this.collection = collection;
        this.socket.on('data', str => this.handleResponse(String(str)));
    }

    private currentMessageBuffer = '';
    handleResponse(message: string): void {
        if(!message.endsWith('\n')) {
            this.currentMessageBuffer += message;
            return;
        }
        message = this.currentMessageBuffer + message;
        this.currentMessageBuffer = '';
        this.outputChannel.appendLine('Received: ' + message);
        this.onceOnLineReceived?.(message);
        this.onceOnLineReceived = undefined;
    }

    private onceOnLineReceived: undefined | ((line: string) => void);

    sendCommand(command: object): void {
        this.outputChannel.appendLine('Sending: ' + JSON.stringify(command));
        this.socket.write(JSON.stringify(command) + '\n');
    }

    async sendCommandWithResponse<Target>(command: FlowrMessage): Promise<Target> {
        const response = this.awaitResponse();
        this.sendCommand(command);
        return JSON.parse(await response) as Target;
    }

    awaitResponse(): Promise<string> {
        return new Promise(resolve => {
            this.onceOnLineReceived = resolve;
        });
    }

    async clearSlice(document: vscode.TextDocument) {
        const uri = document.uri;
        this.collection.delete(uri);
    }

    // TODO: caching etc.
    async retrieveSlice(pos: vscode.Position, document: vscode.TextDocument): Promise<string> {
        const filename = document.fileName;
        const content = document.getText();
        const uri = document.uri;

        pos = FlowrInternalSession.getPositionAt(pos, document)?.start ?? pos;

        // TODO: allow to clear filetokens again? With this we just overwrite :D
        const response = await this.sendCommandWithResponse<FileAnalysisResponseMessageJson>({
            type: 'request-file-analysis',
            id: String(this.idCounter++),
            filename,
            format: 'json',
            filetoken: '@tmp',
            content
        });

        // now we want to collect all ids from response in a map again (id -> location)
        const idToLocation = new Map<NodeId, SourceRange>();
        visitAst(response.results.normalize.ast, n => {
            if(n.location) {
                idToLocation.set(n.info.id, n.location);
            }
        });

        // TODO: check for errors etc
        const sliceResponse = await this.sendCommandWithResponse<SliceResponseMessage>({
            'type': 'request-slice',
            'id': String(this.idCounter++),
            'filetoken': '@tmp',
            'criterion': [`${pos.line + 1}:${pos.character + 1}`]
        });
        // TODO: we should be more robust :D
        const sliceElements = [...sliceResponse.results.slice.result].map(id => ({ id, location: idToLocation.get(id) }))
            .filter(e => isNotUndefined(e.location)) as { id: NodeId, location: SourceRange; }[];
        // sort by start
        sliceElements.sort((a: { location: SourceRange; }, b: { location: SourceRange; }) => {
            return a.location.start.line - b.location.start.line || a.location.start.column - b.location.start.column;
        });
        const diagnostics: vscode.Diagnostic[] = [];
        const blockedLines = new Set<number>();
        for(const slice of sliceElements) {
            blockedLines.add(slice.location.start.line - 1);
        }
        for(let i = 0; i < document.lineCount; i++) {
            if(blockedLines.has(i)) {
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
        this.outputChannel.appendLine('slice: ' + JSON.stringify([...sliceResponse.results.slice.result]));
        return '';
    }
}
