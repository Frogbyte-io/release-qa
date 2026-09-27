import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { childrenOf, descendantsOf, portInUse, processesRunning, waitForPort } from '../../src/drivers/os.ts';
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

describe('the descendants of a process', () => {
  test('includes children and grandchildren', async () => {
    // A child that starts its own child and prints its pid.
    const script = "const { spawn } = require('child_process'); const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(g.pid); setInterval(() => {}, 1000);";
    const child = trackProcess(spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] }));
    const grandchild = await new Promise<number>((resolve) => child.stdout!.once('data', (chunk: Buffer) => resolve(Number(String(chunk).trim()))));
    try {
      const descendants = await descendantsOf(process.pid);
      expect(descendants).toContain(child.pid);
      expect(descendants).toContain(grandchild);
    } finally {
      try { process.kill(grandchild); } catch { /* gone */ }
    }
  });
});

describe('waiting for a port can be stopped', () => {
  test('an aborted wait rejects at once instead of running to its timeout', async () => {
    const controller = new AbortController();
    const began = Date.now();
    setTimeout(() => controller.abort(new Error('the driver exited')), 150);
    await expect(waitForPort(1, 20_000, controller.signal)).rejects.toThrow('the driver exited');
    expect(Date.now() - began).toBeLessThan(5000);
  });
});

describe.skipIf(process.platform === 'win32')('reading /proc (Linux)', () => {
  afterEach(() => {
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
  });

  test('a /proc that cannot be listed is an error, not "no processes": that would wave through a running app', async () => {
    vi.doMock('node:fs/promises', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:fs/promises')>()), readdir: async () => { throw Object.assign(new Error('EACCES: /proc'), { code: 'EACCES' }); } }));
    vi.resetModules();
    const os = await import('../../src/drivers/os.ts');
    await expect(os.processesRunning(process.execPath)).rejects.toThrow('/proc');
    await expect(os.childrenOf(process.pid)).rejects.toThrow('/proc');
  });

  test('a process that vanished or belongs to another user is skipped, and the rest still found', async () => {
    const child = sleeper();
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const real = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...real,
        readdir: async (path: string) => ['999999998', '999999999', ...((await real.readdir(path)) as unknown as string[])],
        readlink: async (path: string) => {
          if (path.startsWith('/proc/999999998/')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
          if (path.startsWith('/proc/999999999/')) throw Object.assign(new Error('not yours'), { code: 'EACCES' });
          return real.readlink(path);
        },
      };
    });
    vi.resetModules();
    const os = await import('../../src/drivers/os.ts');
    expect(await os.processesRunning(process.execPath)).toContain(child.pid);
  });
});
