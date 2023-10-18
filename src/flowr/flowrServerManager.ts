import * as net from 'net';
import * as vscode from 'vscode';
import { FileAnalysisResponseMessageJson, FlowrMessage, SliceResponseMessage, SliceResult } from './messages';

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
       const response =  this.awaitResponse();
       this.sendCommand(command);
       return JSON.parse(await response) as Target;
   }

   awaitResponse(): Promise<string> {
       return new Promise(resolve => {
           this.onceOnLineReceived = resolve;
       });
   }

   // TODO: caching etc.
   async retrieveSlice(pos: vscode.Position, document: vscode.TextDocument): Promise<string> {
       const filename = document.fileName;
       const content = document.getText();
       const uri = document.uri;
       // TODO: allow to clear filetokens again? With this we just overwrite :D
       const response = await this.sendCommandWithResponse<FileAnalysisResponseMessageJson>({
           type:      'request-file-analysis',
           id:        String(this.idCounter++),
           filename,
           format:    'json',
           filetoken: '@tmp',
           content
       });
       // TODO: check for errors etc
       const sliceResponse = await this.sendCommandWithResponse<SliceResponseMessage>({
           'type':      'request-slice',
           'id':        String(this.idCounter++),
           'filetoken': '@tmp',
           'criterion': [`${pos.line+1}:${pos.character+1}`]
       });
       // TODO: we should be more robust :D
       const sliceElements = sliceResponse.results.slice.result;
       // sort by start
       sliceElements.sort((a, b) => {
           return a.location.start.line - b.location.start.line || a.location.start.column - b.location.start.column;
       });
       const diagnostics: vscode.Diagnostic[] = [];
       let currentSource = { line: 0, column: 0 };
       const blockingSet = new Set<string>();
       for(const slice of sliceElements) {
           const location = JSON.stringify(slice.location);
           if(blockingSet.has(location)) {
               continue;
           }
           blockingSet.add(location);
           this.newDiagnostics(diagnostics, currentSource, slice);
           currentSource = {
               line: slice.location.end.line - 1,
               column: slice.location.end.column
           };
       }
       const end = {
           line: document.lineCount,
           column: document.lineAt(document.lineCount - 1).text.length + 1
       };
       this.newDiagnostics(diagnostics, currentSource, {
           id: 'end',
           location: {
               start: end,
               end
           }
       });
       this.collection.set(uri, diagnostics);
       this.outputChannel.appendLine('slice: ' + JSON.stringify(sliceResponse.results.slice.result));
       return '';
   }


   private newDiagnostics(diagnostics: vscode.Diagnostic[], currentSource: { line: number; column: number; }, slice: SliceResult) {
       const range = new vscode.Range(currentSource.line, currentSource.column, slice.location.start.line - 1, slice.location.start.column-1);
       this.outputChannel.appendLine('newDiagnostics: ' + JSON.stringify(range) + ' ' +  JSON.stringify(slice));
       if(range.isEmpty) {
           return;
       }
       diagnostics.push({
           message: 'irrelevant for the slice',
           range,
           severity: vscode.DiagnosticSeverity.Hint,
           tags: [vscode.DiagnosticTag.Unnecessary]
       });
   }
}