import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import { createServer, type Server as NetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
const launcherPath = fileURLToPath(new URL('../serve.mjs', import.meta.url));
const { createStaticServer, listenStaticServer, parseArguments } = await import(new URL('../serve.mjs', import.meta.url).href) as {
  createStaticServer(projectDir: string): Promise<Server>;
  listenStaticServer(server: Server, options?: { port?: number; explicitPort?: boolean }): Promise<string>;
  parseArguments(args: string[]): { port: number; explicitPort: boolean; openBrowser: boolean; help: boolean };
};

type HttpResult = { status: number | undefined; headers: IncomingHttpHeaders; body: string };

function addressOf(server: Server | NetServer) {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address;
}

async function fixture(t: TestContext) {
  const projectDir = await mkdtemp(join(tmpdir(), 'portside-launcher-test-'));
  t.after(async () => {
    assert.equal(dirname(projectDir), tmpdir());
    assert.ok(basename(projectDir).startsWith('portside-launcher-test-'));
    await rm(projectDir, { recursive: true, force: true });
  });
  await mkdir(join(projectDir, 'dist', 'assets'), { recursive: true });
  await mkdir(join(projectDir, 'src'));
  await writeFile(join(projectDir, 'dist', 'index.html'), '<!doctype html><title>Public game</title>');
  await writeFile(join(projectDir, 'dist', 'assets', 'index-AbCd_123.js'), 'console.log("game");');
  await writeFile(join(projectDir, 'dist', 'assets', 'index-AbCd_123.css'), 'body{margin:0}');
  await writeFile(join(projectDir, 'dist', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(projectDir, 'src', 'private.txt'), 'PRIVATE SOURCE');
  await writeFile(join(projectDir, 'package.json'), JSON.stringify({ version: '2.0.0' }));
  return projectDir;
}

async function serve(t: TestContext, projectDir: string) {
  const server = await createStaticServer(projectDir);
  const url = await listenStaticServer(server, { port: 0, explicitPort: true });
  t.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  return { server, url };
}

function get(url: string, path: string, method = 'GET'): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(new URL(url), { path, method }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      response.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves the built game with MIME, HEAD and appropriate cache headers', async (t) => {
  const projectDir = await fixture(t);
  const { server, url } = await serve(t, projectDir);
  assert.equal(addressOf(server).address, '127.0.0.1');
  const index = await get(url, '/?cache=1');
  assert.equal(index.status, 200);
  assert.match(index.body, /Public game/);
  assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(index.headers['cache-control'], 'no-cache');
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  const script = await get(url, '/assets/index-AbCd_123.js?cache=1');
  assert.equal(script.status, 200);
  assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(script.headers['cache-control'], 'public, max-age=31536000, immutable');
  const head = await get(url, '/assets/index-AbCd_123.js', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(Number(head.headers['content-length']), Buffer.byteLength(script.body));
  assert.equal((await get(url, '/assets/index-AbCd_123.css')).headers['content-type'], 'text/css; charset=utf-8');
  assert.equal((await get(url, '/favicon.svg')).headers['content-type'], 'image/svg+xml');
});

test('does not serve source files, directories, missing routes or unsupported methods', async (t) => {
  const projectDir = await fixture(t);
  const { url } = await serve(t, projectDir);
  for (const path of ['/src/private.txt', '/package.json', '/serve.mjs', '/assets', '/assets/', '/missing']) {
    const response = await get(url, path);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(response.body, /PRIVATE SOURCE|index-AbCd|portside-launcher-test/);
  }
  const post = await get(url, '/', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});

test('rejects raw and encoded traversal, Windows separators, streams and malformed encoding', async (t) => {
  const projectDir = await fixture(t);
  const { url } = await serve(t, projectDir);
  for (const path of [
    '/../src/private.txt', '/%2e%2e/src/private.txt', '/assets/%2E%2E/%2e%2E/src/private.txt',
    '/%2e%2e%2fsrc%2fprivate.txt', '/..%5csrc%5cprivate.txt', '/%5c%5cserver%5cshare',
    '/C:%5cWindows%5cwin.ini', '/index.html:stream', '/index.html%00.js',
  ]) {
    const response = await get(url, path);
    assert.equal(response.status, 403, path);
    assert.doesNotMatch(response.body, /PRIVATE SOURCE/);
  }
  assert.equal((await get(url, '/%E0%A4%A')).status, 400);
  assert.equal((await get(url, '/%zz')).status, 400);
  assert.equal((await get(url, '/%252e%252e/src/private.txt')).status, 404);
});

test('rejects symbolic directory links escaping the built assets', async (t) => {
  const projectDir = await fixture(t);
  await symlink(join(projectDir, 'src'), join(projectDir, 'dist', 'escaped'), process.platform === 'win32' ? 'junction' : 'dir');
  const { url } = await serve(t, projectDir);
  const response = await get(url, '/escaped/private.txt');
  assert.equal(response.status, 403);
  assert.doesNotMatch(response.body, /PRIVATE SOURCE/);
});

test('requires a regular index file and reports a missing build clearly', async (t) => {
  const projectDir = await fixture(t);
  await rm(join(projectDir, 'dist', 'index.html'));
  await assert.rejects(createStaticServer(projectDir), /game build is missing/);
  await mkdir(join(projectDir, 'dist', 'index.html'));
  await assert.rejects(createStaticServer(projectDir), /game build is missing/);
});

test('finds a free port when automatic selection encounters an occupied port', async (t) => {
  const projectDir = await fixture(t);
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
  const port = addressOf(occupied).port;
  assert.ok(port < 65535);
  const server = await createStaticServer(projectDir);
  t.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const url = await listenStaticServer(server, { port });
  assert.ok(addressOf(server).port > port);
  assert.equal((await get(url, '/')).status, 200);
});

test('an explicit occupied port fails with a useful error without changing ports', async (t) => {
  const projectDir = await fixture(t);
  const { server: occupied } = await serve(t, projectDir);
  const port = addressOf(occupied).port;
  const server = await createStaticServer(projectDir);
  await assert.rejects(listenStaticServer(server, { port, explicitPort: true }), new RegExp(`Port ${port} is already in use`));
  assert.equal(server.listening, false);
});

test('validates CLI arguments and keeps automatic browser opening opt-in', () => {
  assert.deepEqual(parseArguments([]), { port: 5182, explicitPort: false, openBrowser: false, help: false });
  assert.deepEqual(parseArguments(['--port', '6000', '--open']), { port: 6000, explicitPort: true, openBrowser: true, help: false });
  assert.equal(parseArguments(['--port=6001']).port, 6001);
  for (const args of [['--port'], ['--port', '0'], ['--port', '65536'], ['--port', '12x'], ['--port', '-1'], ['--port', '1', '--port=2'], ['--host', '0.0.0.0']]) {
    assert.throws(() => parseArguments(args));
  }
});

test('CLI prints the actual project folder and version and serves independently of cwd', async (t) => {
  const projectDir = await fixture(t);
  await copyFile(launcherPath, join(projectDir, 'serve.mjs'));
  const child = spawn(process.execPath, [join(projectDir, 'serve.mjs')], { cwd: tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const output = await new Promise<string>((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => reject(new Error(`Launcher did not start: ${stderr}`)), 5000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (/URL: http:\/\/127\.0\.0\.1:\d+\//.test(stdout)) {
        clearTimeout(timeout);
        resolve(stdout);
      }
    });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Launcher exited ${code}: ${stderr}`)); });
  });
  assert.ok(output.includes('Portside 2.0.0'));
  assert.ok(output.includes(`Folder: ${projectDir}`));
  const urlMatch = output.match(/URL: (http:\/\/127\.0\.0\.1:\d+\/)/);
  assert.ok(urlMatch);
  const url = urlMatch[1];
  assert.equal((await get(url, '/')).status, 200);
  assert.equal(stderr, '');
});
