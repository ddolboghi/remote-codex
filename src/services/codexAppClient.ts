type JsonRpcResponse = {
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type ServerMessage = JsonRpcResponse | { method: string; params?: any };
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type TextDeltaCallback = (threadId: string, text: string, turnId: string) => void;
type TurnCompletedCallback = (threadId: string, turnId: string, error: Error | null) => void;
type ErrorCallback = (error: Error) => void;

const CLIENT_INFO = {
  name: 'remote-codex',
  title: 'Remote Codex',
  version: '1.0.0',
};

function getString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export interface SessionInfo {
  id: string;
  title: string;
}

export class CodexAppClient {
  private socket: WebSocket | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private initialized = false;
  private textDeltaCallbacks: TextDeltaCallback[] = [];
  private turnCompletedCallbacks: TurnCompletedCallback[] = [];
  private errorCallbacks: ErrorCallback[] = [];

  constructor(private readonly port: number) {}

  connect(): Promise<void> {
    if (this.initialized && this.socket && this.socket.readyState === 1) {
      return Promise.resolve();
    }

    const socket = new WebSocket(`ws://127.0.0.1:${this.port}`);
    this.socket = socket;

    socket.addEventListener('message', (event) => {
      this.handleMessage(String(event.data));
    });

    socket.addEventListener('error', () => {
      this.rejectAll(new Error('Codex app-server WebSocket error'));
      this.emitError(new Error('Codex app-server WebSocket error'));
    });

    socket.addEventListener('close', () => {
      this.initialized = false;
      this.rejectAll(new Error('Codex app-server WebSocket closed'));
    });

    return new Promise((resolve, reject) => {
      socket.addEventListener('open', () => {
        this.request('initialize', {
          clientInfo: CLIENT_INFO,
          capabilities: { experimentalApi: true },
        })
          .then(() => {
            this.sendNotification('initialized');
            this.initialized = true;
            resolve();
          })
          .catch(reject);
      });
    });
  }

  async startThread(projectPath: string, model?: string): Promise<string> {
    const result: any = await this.request('thread/start', {
      cwd: projectPath,
      model: model ?? null,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });

    const threadId = result?.thread?.id;
    if (!threadId) {
      throw new Error('Invalid Codex thread/start response: missing thread.id');
    }
    return threadId;
  }

  async startTurn(threadId: string, prompt: string, model?: string): Promise<string> {
    const params: Record<string, unknown> = {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
    };

    if (model) {
      params.model = model;
    }

    const result: any = await this.request('turn/start', params);
    const turnId = result?.turn?.id;
    if (!turnId) {
      throw new Error('Invalid Codex turn/start response: missing turn.id');
    }
    return turnId;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<boolean> {
    await this.request('turn/interrupt', { threadId, turnId });
    return true;
  }

  async listThreads(cwd?: string, limit = 25): Promise<SessionInfo[]> {
    const params: { limit: number; cwd?: string } = { limit };
    if (cwd) {
      params.cwd = cwd;
    }

    const result: any = await this.request('thread/list', params);
    const threads = Array.isArray(result?.threads) ? result.threads : Array.isArray(result?.data) ? result.data : [];
    return threads.map((thread: any) => ({
      id: getString(thread.id),
      title: getString(thread.name) || getString(thread.preview) || 'untitled',
    })).filter((thread: SessionInfo) => thread.id);
  }

  async getThreadInfo(threadId: string): Promise<SessionInfo | null> {
    try {
      const result: any = await this.request('thread/read', { threadId, includeTurns: false });
      const thread = result?.thread;
      if (!thread?.id) {
        return null;
      }
      return {
        id: thread.id,
        title: getString(thread.name) || getString(thread.preview) || 'untitled',
      };
    } catch {
      return null;
    }
  }

  async listModels(): Promise<string[]> {
    const models: string[] = [];
    let cursor: string | null = null;

    do {
      const result: any = await this.request('model/list', {
        cursor,
        limit: 100,
        includeHidden: false,
      });
      const page = Array.isArray(result?.data) ? result.data : [];
      for (const model of page) {
        if (typeof model?.model === 'string') {
          models.push(model.model);
        } else if (typeof model?.id === 'string') {
          models.push(model.id);
        }
      }
      cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : null;
    } while (cursor);

    return Array.from(new Set(models)).sort();
  }

  onTextDelta(callback: TextDeltaCallback): void {
    this.textDeltaCallbacks.push(callback);
  }

  onTurnCompleted(callback: TurnCompletedCallback): void {
    this.turnCompletedCallbacks.push(callback);
  }

  onError(callback: ErrorCallback): void {
    this.errorCallbacks.push(callback);
  }

  disconnect(): void {
    this.socket?.close();
    this.socket = null;
    this.initialized = false;
    this.rejectAll(new Error('Codex app-server WebSocket closed'));
  }

  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === 1;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      return Promise.reject(new Error('Codex app-server WebSocket is not connected'));
    }

    const id = this.nextRequestId++;
    const message = { id, method, params };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.send(JSON.stringify(message));
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    this.socket?.send(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  private handleMessage(raw: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw);
    } catch (error) {
      this.emitError(new Error(`Failed to parse Codex app-server message: ${error}`));
      return;
    }

    if ('id' in message) {
      this.handleResponse(message);
      return;
    }

    this.handleNotification(message);
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);

    if (response.error) {
      pending.reject(new Error(response.error.message ?? `Codex app-server request ${response.id} failed`));
      return;
    }

    pending.resolve(response.result);
  }

  private handleNotification(notification: { method: string; params?: any }): void {
    if (notification.method === 'item/agentMessage/delta') {
      const { threadId, turnId, delta } = notification.params ?? {};
      if (typeof threadId === 'string' && typeof turnId === 'string' && typeof delta === 'string') {
        this.textDeltaCallbacks.forEach((callback) => callback(threadId, delta, turnId));
      }
      return;
    }

    if (notification.method === 'turn/completed') {
      const { threadId, turn } = notification.params ?? {};
      if (typeof threadId === 'string' && typeof turn?.id === 'string') {
        const error = turn.error?.message ? new Error(turn.error.message) : null;
        this.turnCompletedCallbacks.forEach((callback) => callback(threadId, turn.id, error));
      }
      return;
    }

    if (notification.method === 'error') {
      const message = notification.params?.error?.message ?? 'Codex app-server error';
      this.emitError(new Error(message));
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private emitError(error: Error): void {
    this.errorCallbacks.forEach((callback) => callback(error));
  }
}
