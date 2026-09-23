import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { childrenOf, portInUse, processesRunning, waitForPort } from '../../src/drivers/os.ts';
import { cleanUpProcessesAndRoots, trackProcess } from '../fixtures/processes.ts';

// Listing processes starts PowerShell on Windows, which can take seconds on a busy CI runner.
vi.setConfig({ testTimeout: 30_000 });
afterEach(cleanUpProcessesAndRoots);

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

const listen = async (): Promise<number> => {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
};

const sleeper = () => trackProcess(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }));

describe('finding processes by their exact executable', () => {
  test('lists a running process started from that executable', async () => {
    const child = sleeper();
    const pids = await processesRunning(process.execPath);
    expect(pids).toContain(child.pid);
  });

  test('an executable nothing is running from lists nothing, not everything', async () => {
    expect(await processesRunning(`${process.execPath}.not-running`)).toEqual([]);
  });
});

describe('finding the children of a process', () => {
  test('lists a process this one started, and not unrelated ones', async () => {
    const child = sleeper();
    const children = await childrenOf(process.pid);
    expect(children).toContain(child.pid);
    expect(await childrenOf(child.pid as number)).toEqual([]);
  });
});

describe('ports', () => {
  test('a listening port is in use; a closed one is not', async () => {
    const port = await listen();
    expect(await portInUse(port)).toBe(true);
    await new Promise((resolve) => servers.pop()?.close(resolve));
    expect(await portInUse(port)).toBe(false);
  });

  test('waiting for a port that starts listening succeeds; one that never does is a timeout naming it', async () => {
    const port = await listen();
    await expect(waitForPort(port, 2000)).resolves.toBeUndefined();
    await new Promise((resolve) => servers.pop()?.close(resolve));
    await expect(waitForPort(port, 300)).rejects.toThrow(String(port));
  });
});
