import { beforeEach, describe, expect, it, vi } from 'vitest';

const dataStoreMock = vi.hoisted(() => {
  const threadSessions = new Map<string, { threadId: string; sessionId: string; projectPath: string; port: number; createdAt: number; lastUsedAt: number }>();

  return {
    reset: () => threadSessions.clear(),
    getThreadSession: vi.fn((threadId: string) => threadSessions.get(threadId)),
    getAllThreadSessions: vi.fn(() => Array.from(threadSessions.values())),
    setThreadSession: vi.fn((session: { threadId: string; sessionId: string; projectPath: string; port: number; createdAt: number; lastUsedAt: number }) => {
      threadSessions.set(session.threadId, session);
    }),
    updateThreadSessionLastUsed: vi.fn((threadId: string) => {
      const session = threadSessions.get(threadId);
      if (session) {
        session.lastUsedAt = Date.now();
      }
    }),
    clearThreadSession: vi.fn((threadId: string) => {
      threadSessions.delete(threadId);
    }),
  };
});

const codexMock = vi.hoisted(() => {
  const instances: any[] = [];

  class MockCodexAppClient {
    connect = vi.fn(async () => {});
    startThread = vi.fn(async () => 'codex-thread-new');
    startTurn = vi.fn(async () => 'turn-new');
    getThreadInfo = vi.fn(async (threadId: string) => ({ id: threadId, title: 'Codex thread' }));
    listThreads = vi.fn(async () => [{ id: 'codex-thread-1', title: 'First thread' }]);
    interruptTurn = vi.fn(async () => true);
    disconnect = vi.fn();
    isConnected = vi.fn(() => true);

    constructor(public port: number) {
      instances.push(this);
    }
  }

  return {
    instances,
    MockCodexAppClient,
    reset: () => {
      instances.length = 0;
    },
  };
});

vi.mock('../services/dataStore.js', () => ({
  getThreadSession: dataStoreMock.getThreadSession,
  getAllThreadSessions: dataStoreMock.getAllThreadSessions,
  setThreadSession: dataStoreMock.setThreadSession,
  updateThreadSessionLastUsed: dataStoreMock.updateThreadSessionLastUsed,
  clearThreadSession: dataStoreMock.clearThreadSession,
}));

vi.mock('../services/codexAppClient.js', () => ({
  CodexAppClient: codexMock.MockCodexAppClient,
}));

import {
  abortSession,
  clearActiveTurn,
  clearSessionForThread,
  clearSseClient,
  createSession,
  ensureSessionForThread,
  getActiveTurn,
  getSessionForThread,
  getSseClient,
  resetSessionManagerForTests,
  listSessions,
  sendPrompt,
  setActiveTurn,
  setSessionForThread,
  setSseClient,
} from '../services/sessionManager.js';

describe('SessionManager', () => {
  beforeEach(() => {
    dataStoreMock.reset();
    codexMock.reset();
    resetSessionManagerForTests();
    vi.clearAllMocks();
  });

  describe('Codex thread lifecycle', () => {
    it('creates a Codex app-server client and starts a thread', async () => {
      const sessionId = await createSession(3000, '/repo', 'gpt-5.5');

      const client = codexMock.instances[0];
      expect(client.connect).toHaveBeenCalled();
      expect(client.startThread).toHaveBeenCalledWith('/repo', 'gpt-5.5');
      expect(sessionId).toBe('codex-thread-new');
    });

    it('reuses an existing valid Codex thread for the same project', async () => {
      setSessionForThread('thread-1', 'codex-thread-existing', '/repo', 3000);
      const original = dataStoreMock.getThreadSession('thread-1');

      const sessionId = await ensureSessionForThread('thread-1', '/repo', 3000, 'gpt-5.5');

      const client = codexMock.instances[0];
      expect(client.getThreadInfo).toHaveBeenCalledWith('codex-thread-existing');
      expect(client.startThread).not.toHaveBeenCalled();
      expect(sessionId).toBe('codex-thread-existing');
      expect(dataStoreMock.getThreadSession('thread-1')?.createdAt).toBe(original?.createdAt);
    });

    it('creates a new Codex thread when the stored thread is invalid', async () => {
      setSessionForThread('thread-1', 'codex-thread-stale', '/repo', 3000);

      const promise = ensureSessionForThread('thread-1', '/repo', 3000);
      const client = codexMock.instances[0];
      client.getThreadInfo.mockResolvedValueOnce(null);

      const sessionId = await promise;

      expect(sessionId).toBe('codex-thread-new');
      expect(dataStoreMock.getThreadSession('thread-1')?.sessionId).toBe('codex-thread-new');
    });

    it('creates a new Codex thread when the project path changes', async () => {
      setSessionForThread('thread-1', 'codex-thread-old', '/old', 3000);

      const sessionId = await ensureSessionForThread('thread-1', '/new', 3000);

      const client = codexMock.instances[0];
      expect(client.getThreadInfo).not.toHaveBeenCalled();
      expect(client.startThread).toHaveBeenCalledWith('/new', undefined);
      expect(sessionId).toBe('codex-thread-new');
    });
  });

  describe('prompt and interrupt', () => {
    it('starts a Codex turn and records the active turn for the mapped Discord thread', async () => {
      setSessionForThread('discord-thread', 'codex-thread', '/repo', 3000);
      await ensureSessionForThread('discord-thread', '/repo', 3000);

      const turnId = await sendPrompt(3000, 'codex-thread', 'Hello Codex', 'gpt-5.5');

      const client = codexMock.instances[0];
      expect(client.startTurn).toHaveBeenCalledWith('codex-thread', 'Hello Codex', 'gpt-5.5');
      expect(turnId).toBe('turn-new');
      expect(getActiveTurn('discord-thread')).toBe('turn-new');
    });

    it('interrupts the active Codex turn', async () => {
      setSessionForThread('discord-thread', 'codex-thread', '/repo', 3000);
      await ensureSessionForThread('discord-thread', '/repo', 3000);
      setActiveTurn('discord-thread', 'turn-123');

      await expect(abortSession(3000, 'codex-thread')).resolves.toBe(true);

      const client = codexMock.instances[0];
      expect(client.interruptTurn).toHaveBeenCalledWith('codex-thread', 'turn-123');
    });
  });

  describe('thread-session mapping', () => {
    it('stores and retrieves session for thread', () => {
      setSessionForThread('thread1', 'codex-thread-123', '/path/to/project', 4000);

      expect(getSessionForThread('thread1')).toEqual({
        sessionId: 'codex-thread-123',
        projectPath: '/path/to/project',
        port: 4000,
      });
    });

    it('clears session and active turn for thread', () => {
      setSessionForThread('thread2', 'codex-thread-456', '/path/to/project2', 4001);
      setActiveTurn('thread2', 'turn-456');

      clearSessionForThread('thread2');

      expect(getSessionForThread('thread2')).toBeUndefined();
      expect(getActiveTurn('thread2')).toBeUndefined();
    });

    it('preserves createdAt when updating an existing thread session', () => {
      setSessionForThread('thread3', 'codex-thread-original', '/path/to/project', 4004);
      const original = dataStoreMock.getThreadSession('thread3');

      setSessionForThread('thread3', 'codex-thread-original', '/path/to/project', 4005);

      const updated = dataStoreMock.getThreadSession('thread3');
      expect(updated?.createdAt).toBe(original?.createdAt);
      expect(updated?.port).toBe(4005);
    });
  });

  describe('client management compatibility', () => {
    it('stores and retrieves the active client for a thread', async () => {
      await ensureSessionForThread('thread1', '/repo', 3000);
      const client = codexMock.instances[0];

      expect(getSseClient('thread1')).toBe(client);
    });

    it('supports the old stream client setter alias for queue compatibility', () => {
      const mockClient = {
        isConnected: vi.fn(() => true),
        disconnect: vi.fn(),
      };

      setSseClient('thread2', mockClient);

      expect(getSseClient('thread2')).toBe(mockClient);
      clearSseClient('thread2');
      expect(getSseClient('thread2')).toBeUndefined();
    });

    it('lists Codex threads through a connected app-server client filtered by project path', async () => {
      const sessions = await listSessions(3000, '/repo');

      expect(codexMock.instances[0].listThreads).toHaveBeenCalledWith('/repo');
      expect(sessions).toEqual([{ id: 'codex-thread-1', title: 'First thread' }]);
    });

    it('clears active turn independently', () => {
      setActiveTurn('thread3', 'turn-789');
      clearActiveTurn('thread3');
      expect(getActiveTurn('thread3')).toBeUndefined();
    });
  });
});
