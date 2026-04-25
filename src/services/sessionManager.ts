import * as dataStore from './dataStore.js';
import { CodexAppClient, type SessionInfo } from './codexAppClient.js';

const threadClients = new Map<string, CodexAppClient>();
const portClients = new Map<number, CodexAppClient>();
const activeTurns = new Map<string, string>();

export async function createSession(port: number, projectPath = process.cwd(), model?: string): Promise<string> {
  const client = new CodexAppClient(port);
  await client.connect();
  portClients.set(port, client);
  return client.startThread(projectPath, model);
}

export async function sendPrompt(port: number, sessionId: string, text: string, model?: string): Promise<string> {
  const client = findClientByPort(port);
  if (!client) {
    throw new Error('Codex app-server client is not connected for this port');
  }

  const turnId = await client.startTurn(sessionId, text, model);
  const threadId = findThreadIdBySessionId(sessionId);
  if (threadId) {
    activeTurns.set(threadId, turnId);
  }
  return turnId;
}

export async function validateSession(port: number, sessionId: string): Promise<boolean> {
  let client = findClientByPort(port);
  if (!client) {
    client = await connectPortClient(port);
  }
  return (await client.getThreadInfo(sessionId)) !== null;
}

export async function getSessionInfo(port: number, sessionId: string): Promise<SessionInfo | null> {
  let client = findClientByPort(port);
  if (!client) {
    client = await connectPortClient(port);
  }
  return client.getThreadInfo(sessionId);
}

export async function listSessions(port: number, projectPath?: string): Promise<SessionInfo[]> {
  let client = findClientByPort(port);
  if (!client) {
    client = await connectPortClient(port);
  }
  return client.listThreads(projectPath);
}

export async function abortSession(port: number, sessionId: string, turnId?: string): Promise<boolean> {
  try {
    const client = findClientByPort(port);
    const activeTurnId = turnId ?? findActiveTurnBySessionId(sessionId);
    if (!client || !activeTurnId) {
      return false;
    }
    return client.interruptTurn(sessionId, activeTurnId);
  } catch {
    return false;
  }
}

export function getSessionForThread(threadId: string): { sessionId: string; projectPath: string; port: number } | undefined {
  const session = dataStore.getThreadSession(threadId);
  if (!session) return undefined;
  return { sessionId: session.sessionId, projectPath: session.projectPath, port: session.port };
}

export function setSessionForThread(threadId: string, sessionId: string, projectPath: string, port: number): void {
  const existing = dataStore.getThreadSession(threadId);
  const now = Date.now();
  dataStore.setThreadSession({
    threadId,
    sessionId,
    projectPath,
    port,
    createdAt: existing?.createdAt ?? now,
    lastUsedAt: now,
  });
}

export async function ensureSessionForThread(threadId: string, projectPath: string, port: number, model?: string): Promise<string> {
  const existingSession = getSessionForThread(threadId);
  let client = threadClients.get(threadId);

  if (!client || !client.isConnected()) {
    client = new CodexAppClient(port);
    await client.connect();
    threadClients.set(threadId, client);
    portClients.set(port, client);
  }

  if (existingSession && existingSession.projectPath === projectPath) {
    const isValid = await client.getThreadInfo(existingSession.sessionId);
    if (isValid) {
      setSessionForThread(threadId, existingSession.sessionId, projectPath, port);
      return existingSession.sessionId;
    }
  }

  const sessionId = await client.startThread(projectPath, model);
  setSessionForThread(threadId, sessionId, projectPath, port);
  return sessionId;
}

export function updateSessionLastUsed(threadId: string): void {
  dataStore.updateThreadSessionLastUsed(threadId);
}

export function clearSessionForThread(threadId: string): void {
  dataStore.clearThreadSession(threadId);
  activeTurns.delete(threadId);
}

export function setCodexClient(threadId: string, client: CodexAppClient): void {
  threadClients.set(threadId, client);
  const session = dataStore.getThreadSession(threadId);
  if (session) {
    portClients.set(session.port, client);
  }
}

export function getCodexClient(threadId: string): CodexAppClient | undefined {
  return threadClients.get(threadId);
}

export function clearCodexClient(threadId: string): void {
  threadClients.delete(threadId);
  activeTurns.delete(threadId);
}

export function setActiveTurn(threadId: string, turnId: string): void {
  activeTurns.set(threadId, turnId);
}

export function clearActiveTurn(threadId: string): void {
  activeTurns.delete(threadId);
}

export function getActiveTurn(threadId: string): string | undefined {
  return activeTurns.get(threadId);
}

export function resetSessionManagerForTests(): void {
  threadClients.clear();
  portClients.clear();
  activeTurns.clear();
}

export function setSseClient(threadId: string, client: { isConnected(): boolean; disconnect(): void }): void {
  setCodexClient(threadId, client as CodexAppClient);
}

export const getSseClient = getCodexClient;
export const clearSseClient = clearCodexClient;

function findClientByPort(port: number): CodexAppClient | undefined {
  const serviceClient = portClients.get(port);
  if (serviceClient?.isConnected()) {
    return serviceClient;
  }

  for (const [threadId, client] of threadClients) {
    const session = dataStore.getThreadSession(threadId);
    if (session?.port === port) {
      return client;
    }
  }
  return undefined;
}

async function connectPortClient(port: number): Promise<CodexAppClient> {
  const existing = portClients.get(port);
  if (existing?.isConnected()) {
    return existing;
  }
  const client = new CodexAppClient(port);
  await client.connect();
  portClients.set(port, client);
  return client;
}

function findThreadIdBySessionId(sessionId: string): string | undefined {
  return dataStore.getAllThreadSessions().find((session) => session.sessionId === sessionId)?.threadId;
}

function findActiveTurnBySessionId(sessionId: string): string | undefined {
  const threadId = findThreadIdBySessionId(sessionId);
  return threadId ? activeTurns.get(threadId) : undefined;
}
