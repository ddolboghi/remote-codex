import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (event: { data?: string }) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  sent: string[] = [];
  listeners = new Map<string, Listener[]>();
  readyState = 1;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(event: string, listener: Listener): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.readyState = 3;
  }

  emit(event: string, data?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener({ data: typeof data === 'string' ? data : JSON.stringify(data) });
    }
  }
}

describe('CodexAppClient', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  it('initializes the app-server connection and starts a Codex thread', async () => {
    const { CodexAppClient } = await import('../services/codexAppClient.js');
    const client = new CodexAppClient(14097);

    const connectPromise = client.connect();
    const socket = MockWebSocket.instances[0];
    socket.emit('open');

    expect(JSON.parse(socket.sent[0])).toMatchObject({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'remote-codex' },
        capabilities: { experimentalApi: true },
      },
    });

    socket.emit('message', {
      id: 1,
      result: {
        userAgent: 'probe',
        codexHome: '/home/user/.codex',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    });

    await connectPromise;
    expect(JSON.parse(socket.sent[1])).toEqual({ method: 'initialized' });

    const threadPromise = client.startThread('/repo', 'gpt-5.5');
    expect(JSON.parse(socket.sent[2])).toMatchObject({
      id: 2,
      method: 'thread/start',
      params: {
        cwd: '/repo',
        model: 'gpt-5.5',
        approvalPolicy: 'never',
        sandbox: 'danger-full-access',
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      },
    });

    socket.emit('message', {
      id: 2,
      result: {
        thread: { id: 'thread-123' },
      },
    });

    await expect(threadPromise).resolves.toBe('thread-123');
  });

  it('streams assistant deltas and resolves when the turn completes', async () => {
    const { CodexAppClient } = await import('../services/codexAppClient.js');
    const client = new CodexAppClient(14097);
    const deltas: string[] = [];
    const completed = vi.fn();

    client.onTextDelta((threadId, text) => deltas.push(`${threadId}:${text}`));
    client.onTurnCompleted(completed);

    const connectPromise = client.connect();
    const socket = MockWebSocket.instances[0];
    socket.emit('open');
    socket.emit('message', { id: 1, result: { userAgent: 'probe', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' } });
    await connectPromise;

    const turnPromise = client.startTurn('thread-123', 'hello', 'gpt-5.5');
    expect(JSON.parse(socket.sent[2])).toMatchObject({
      id: 2,
      method: 'turn/start',
      params: {
        threadId: 'thread-123',
        input: [{ type: 'text', text: 'hello', text_elements: [] }],
        model: 'gpt-5.5',
      },
    });

    socket.emit('message', {
      id: 2,
      result: { turn: { id: 'turn-123', status: 'inProgress' } },
    });

    await expect(turnPromise).resolves.toBe('turn-123');

    socket.emit('message', {
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-123', turnId: 'turn-123', itemId: 'item-1', delta: 'pong' },
    });
    socket.emit('message', {
      method: 'turn/completed',
      params: { threadId: 'thread-123', turn: { id: 'turn-123', status: 'completed', error: null } },
    });

    expect(deltas).toEqual(['thread-123:pong']);
    expect(completed).toHaveBeenCalledWith('thread-123', 'turn-123', null);
  });

  it('filters listed Codex threads by cwd', async () => {
    const { CodexAppClient } = await import('../services/codexAppClient.js');
    const client = new CodexAppClient(14097);

    const connectPromise = client.connect();
    const socket = MockWebSocket.instances[0];
    socket.emit('open');
    socket.emit('message', { id: 1, result: { userAgent: 'probe', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' } });
    await connectPromise;

    const listPromise = client.listThreads('/repo');
    expect(JSON.parse(socket.sent[2])).toMatchObject({
      id: 2,
      method: 'thread/list',
      params: {
        limit: 25,
        cwd: '/repo',
      },
    });

    socket.emit('message', {
      id: 2,
      result: {
        data: [{ id: 'thread-123', name: 'Repo task', preview: 'fallback' }],
      },
    });

    await expect(listPromise).resolves.toEqual([{ id: 'thread-123', title: 'Repo task' }]);
  });
});
