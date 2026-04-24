import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Server } from 'node:net';
import { delimiter, join } from 'node:path';
import type { ServeInstance } from '../types/index.js';
import { getPortConfig } from './configStore.js';

const DEFAULT_PORT_MIN = 14097;
const DEFAULT_PORT_MAX = 14200;
const WINDOWS_CODEX_COMMANDS = ['codex.cmd', 'codex.exe', 'codex'];
const POSIX_CODEX_COMMANDS = ['codex'];

const instances = new Map<string, ServeInstance>();

function getCodexCommandCandidates(): string[] {
  return process.platform === 'win32' ? WINDOWS_CODEX_COMMANDS : POSIX_CODEX_COMMANDS;
}

function resolveCommandFromPath(command: string, pathValue?: string): string | undefined {
  if (!pathValue) {
    return undefined;
  }

  for (const pathEntry of pathValue.split(delimiter)) {
    if (!pathEntry) {
      continue;
    }

    const resolved = join(pathEntry, command);
    if (existsSync(resolved)) {
      return resolved;
    }
  }

  return undefined;
}

function resolveCodexCommand(env: NodeJS.ProcessEnv): string {
  const pathValue = env.PATH ?? env.Path;

  for (const command of getCodexCommandCandidates()) {
    const resolved = resolveCommandFromPath(command, pathValue);
    if (resolved) {
      return resolved;
    }
  }

  return getCodexCommandCandidates()[0];
}

function formatSpawnError(error: Error, command: string, projectPath: string): string {
  const spawnError = error as NodeJS.ErrnoException;

  if (!existsSync(projectPath)) {
    return `Project path does not exist or is not accessible: ${projectPath}`;
  }

  if (spawnError.code === 'ENOENT') {
    return `Codex executable not found: ${command}. Ensure Codex is installed and available in PATH for this service.`;
  }

  if (spawnError.code === 'EACCES') {
    return `Codex executable is not accessible: ${command}. Check file permissions and service user access.`;
  }

  return spawnError.message || 'Failed to spawn codex app-server process';
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = new Server();
    
    server.once('error', () => {
      resolve(false);
    });
    
    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });
    
    // Bind to 127.0.0.1 explicitly to match codex app-server's loopback listener.
    server.listen(port, '127.0.0.1');
  });
}

async function isOrphanedServerRunning(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
      signal: AbortSignal.timeout(1000),
    });
    // If we get any response, there's already a server running
    return true;
  } catch {
    return false;
  }
}

async function findAvailablePort(): Promise<number> {
  const config = getPortConfig();
  const min = config?.min ?? DEFAULT_PORT_MIN;
  const max = config?.max ?? DEFAULT_PORT_MAX;

  for (let port = min; port <= max; port++) {
    const usedPorts = new Set(Array.from(instances.values()).filter(i => !i.exited).map(i => i.port));
    if (usedPorts.has(port)) {
      continue;
    }
    
    // Check if there's an orphaned Codex app-server on this port.
    if (await isOrphanedServerRunning(port)) {
      continue;
    }
    
    // Check if we can bind to this port
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available ports in range ${min}-${max}`);
}

async function isServerResponding(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function cleanupInstance(key: string): void {
  instances.delete(key);
}

export async function spawnServe(projectPath: string, model?: string): Promise<number> {
  const key = model ? `${projectPath}:${model}` : projectPath;
  const existing = instances.get(key);
  if (existing && !existing.exited) {
    return existing.port;
  }

  // Clean up any exited instance before spawning a new one
  if (existing?.exited) {
    cleanupInstance(key);
  }

  const port = await findAvailablePort();
  
  const args = ['app-server', '--listen', `ws://127.0.0.1:${port}`];
  const env = { ...process.env };
  const command = resolveCodexCommand(env);
  
  console.log(`[codex] Spawning: ${command} ${args.join(' ')}`);
  console.log(`[codex] Working directory: ${projectPath}`);
  
  const child = spawn(command, args, {
    cwd: projectPath,
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  const instance: ServeInstance = {
    port,
    process: child,
    startTime: Date.now(),
    exited: false,
  };

  instances.set(key, instance);

  let stderrBuffer = '';
  let stdoutBuffer = '';

  child.stdout?.on('data', (data) => {
    const text = data.toString();
    stdoutBuffer += text;
    if (stdoutBuffer.length > 2000) {
      stdoutBuffer = stdoutBuffer.slice(-2000);
    }
    console.log(`[codex stdout] ${text.trim()}`);
  });
  
  child.stderr?.on('data', (data) => {
    const text = data.toString();
    stderrBuffer += text;
    if (stderrBuffer.length > 2000) {
      stderrBuffer = stderrBuffer.slice(-2000);
    }
    console.error(`[codex stderr] ${text.trim()}`);
  });

  child.on('exit', (code) => {
    const inst = instances.get(key);
    if (inst) {
      inst.exited = true;
      inst.exitCode = code;
      if (code !== 0 && code !== null) {
        // Combine stdout and stderr for error message
        const combinedOutput = (stderrBuffer.trim() || stdoutBuffer.trim());
        inst.exitError = combinedOutput || `Process exited with code ${code}`;
        console.error(`[codex] Process exited with code ${code}`);
        if (combinedOutput) {
          console.error(`[codex] Output: ${combinedOutput}`);
        }
      }
    }
  });

  child.on('error', (error) => {
    const formattedError = formatSpawnError(error, command, projectPath);
    console.error(`[codex] Spawn error: ${formattedError}`);
    const inst = instances.get(key);
    if (inst) {
      inst.exited = true;
      inst.exitError = formattedError;
    }
  });

  return port;
}

export function getPort(projectPath: string, model?: string): number | undefined {
  const key = model ? `${projectPath}:${model}` : projectPath;
  return instances.get(key)?.port;
}

export function stopServe(projectPath: string, model?: string): boolean {
  const key = model ? `${projectPath}:${model}` : projectPath;
  const instance = instances.get(key);
  if (!instance) {
    return false;
  }

  instance.process.kill();
  cleanupInstance(key);
  return true;
}

export async function waitForReady(port: number, timeout: number = 30000, projectPath?: string, model?: string): Promise<void> {
  const start = Date.now();
  const url = `http://127.0.0.1:${port}/readyz`;
  const key = projectPath ? (model ? `${projectPath}:${model}` : projectPath) : null;

  while (Date.now() - start < timeout) {
    // Check if the process has exited early
    if (key) {
      const instance = instances.get(key);
      if (instance?.exited) {
        const errorMsg = instance.exitError || `codex app-server exited with code ${instance.exitCode}`;
        cleanupInstance(key);
        throw new Error(`codex app-server failed to start: ${errorMsg}`);
      }
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Final check - did the process exit?
  if (key) {
    const instance = instances.get(key);
    if (instance?.exited) {
      const errorMsg = instance.exitError || `codex app-server exited with code ${instance.exitCode}`;
      cleanupInstance(key);
      throw new Error(`codex app-server failed to start: ${errorMsg}`);
    }
  }

  throw new Error(`Service at port ${port} failed to become ready within ${timeout}ms. Check if 'codex app-server' is working correctly.`);
}

export function stopAll(): void {
  for (const [key, instance] of instances) {
    instance.process.kill();
    cleanupInstance(key);
  }
}

export function getAllInstances(): Array<{ key: string; port: number }> {
  return Array.from(instances.entries()).map(([key, instance]) => ({
    key,
    port: instance.port,
  }));
}

export function getInstanceState(projectPath: string, model?: string): { exited: boolean; exitCode?: number | null; exitError?: string } | undefined {
  const key = model ? `${projectPath}:${model}` : projectPath;
  const instance = instances.get(key);
  if (!instance) return undefined;
  return {
    exited: instance.exited ?? false,
    exitCode: instance.exitCode,
    exitError: instance.exitError,
  };
}
