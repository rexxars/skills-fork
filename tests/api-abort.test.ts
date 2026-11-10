import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSkills, resolveSource } from '../src/index.ts';
import * as git from '../src/git.ts';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skills-api-abort-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

/** A broken cancellation path must fail without leaving the test waiting for Git's timeout. */
async function expectAborted(operation: Promise<unknown>, reason: Error): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await expect(
      Promise.race([
        operation,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Operation did not abort')), 1000);
        }),
      ])
    ).rejects.toBe(reason);
  } finally {
    clearTimeout(timer);
  }
}

describe.each([
  { name: 'resolveSource', run: resolveSource },
  { name: 'installSkills', run: installSkills },
])('$name cancellation', ({ run }) => {
  it('stops an active Git clone and preserves the abort reason', async () => {
    const requestStarted = Promise.withResolvers<void>();
    const server = createServer((_request, response) => {
      requestStarted.resolve();
      // Git is waiting for the smart HTTP response when the caller cancels.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP server address');

    const controller = new AbortController();
    const reason = new Error('Cancel the clone');
    const operation = run(`http://127.0.0.1:${address.port}/repo.git`, {
      cwd: root,
      signal: controller.signal,
    });
    // Attach a handler before triggering cancellation.
    const settled = operation.catch((error: unknown) => error);
    try {
      await requestStarted.promise;
      controller.abort(reason);
      await expectAborted(operation, reason);
    } finally {
      controller.abort(reason);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await settled;
    }
  });

  it('cancels stalled GitHub metadata and removes the completed clone', async () => {
    const cloneDir = join(root, 'clone');
    vi.spyOn(git, 'cloneRepo').mockImplementation(async () => {
      await mkdir(cloneDir);
      await writeFile(join(cloneDir, 'SKILL.md'), '---\nname: alpha\ndescription: Alpha\n---\n');
      return cloneDir;
    });
    const requestStarted = Promise.withResolvers<void>();
    const response = Promise.withResolvers<Response>();
    vi.stubGlobal('fetch', (_url: unknown, options?: RequestInit) => {
      requestStarted.resolve();
      return new Promise<Response>((resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        response.promise.then(resolve);
      });
    });
    const controller = new AbortController();
    const reason = new Error('Cancel the metadata request');
    const operation = run('example/skills', { cwd: root, signal: controller.signal });
    const settled = operation.catch((error: unknown) => error);
    try {
      await requestStarted.promise;
      await vi.waitFor(() => expect(existsSync(join(cloneDir, 'SKILL.md'))).toBe(true));
      controller.abort(reason);
      await expectAborted(operation, reason);
      expect(existsSync(cloneDir)).toBe(false);
    } finally {
      response.resolve(new Response('{}'));
      await settled;
    }
  });
});

it('cancels parallel metadata when cloning fails', async () => {
  vi.spyOn(git, 'cloneRepo').mockRejectedValue(new Error('Clone failed'));
  const response = Promise.withResolvers<Response>();
  let metadataAborted = false;
  vi.stubGlobal('fetch', (_url: unknown, options?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        metadataAborted = true;
        reject(options.signal?.reason);
      });
      response.promise.then(resolve);
    });
  });
  try {
    await expect(resolveSource('example/skills', { cwd: root })).rejects.toMatchObject({
      code: 'SKILLS_SOURCE_FETCH_FAILED',
    });
    expect(metadataAborted).toBe(true);
  } finally {
    response.resolve(new Response('{}'));
  }
});
