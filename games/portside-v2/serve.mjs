import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 5182;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
};

function isWithin(base, candidate) {
  const path = relative(base, candidate);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function respond(request, response, status, message, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(message),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(request.method === 'HEAD' ? undefined : message);
}

/** Create a loopback-only game server. Only regular files inside dist are served. */
export async function createStaticServer(projectDir) {
  let distDir;
  try {
    distDir = await realpath(resolve(projectDir, 'dist'));
    const indexPath = await realpath(resolve(distDir, 'index.html'));
    if (!isWithin(distDir, indexPath) || !(await stat(indexPath)).isFile()) throw new Error();
  } catch {
    throw new Error('The game build is missing. Extract the complete archive, including dist, and try again.');
  }

  async function handle(request, response) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      respond(request, response, 405, 'Method not allowed.\n', { Allow: 'GET, HEAD' });
      return;
    }
    let pathname;
    try {
      // Decode before checking segments: URL normalization can otherwise conceal ../.
      const rawPath = (request.url ?? '').split(/[?#]/, 1)[0];
      if (!rawPath.startsWith('/')) throw new Error();
      pathname = decodeURIComponent(rawPath);
    } catch {
      respond(request, response, 400, 'Invalid URL.\n');
      return;
    }
    // Backslashes, drive/stream syntax and dot segments are forbidden on every OS.
    if (/[\\<>:"|?*\u0000-\u001f\u007f]/.test(pathname) || pathname.split('/').some((part) => part === '..')) {
      respond(request, response, 403, 'Forbidden.\n');
      return;
    }
    const requestedFile = pathname === '/' ? 'index.html' : pathname.slice(1);
    const candidate = resolve(distDir, requestedFile);
    if (!isWithin(distDir, candidate)) {
      respond(request, response, 403, 'Forbidden.\n');
      return;
    }
    let filePath;
    let fileInfo;
    try {
      filePath = await realpath(candidate);
      if (!isWithin(distDir, filePath)) {
        respond(request, response, 403, 'Forbidden.\n');
        return;
      }
      fileInfo = await stat(filePath);
      if (!fileInfo.isFile()) {
        respond(request, response, 404, 'Not found.\n');
        return;
      }
    } catch {
      respond(request, response, 404, 'Not found.\n');
      return;
    }
    const hashedAsset = /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(pathname);
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': fileInfo.size,
      'Cache-Control': hashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    await pipeline(createReadStream(filePath), response);
  }

  return createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (response.headersSent || response.destroyed) response.destroy();
      else respond(request, response, 500, 'Unable to read the requested file.\n');
    });
  });
}

/** Explicit ports fail if occupied. The default searches upward from 5182. */
export async function listenStaticServer(server, { port = DEFAULT_PORT, explicitPort = false } = {}) {
  let candidatePort = port;
  while (true) {
    try {
      await new Promise((resolveListen, rejectListen) => {
        const onError = (error) => {
          server.off('listening', onListening);
          rejectListen(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolveListen();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidatePort, HOST);
      });
      const address = server.address();
      return `http://${HOST}:${address.port}/`;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      if (explicitPort || candidatePort >= 65535) {
        throw new Error(`Port ${candidatePort} is already in use. Close the other server or choose another port with --port NUMBER.`);
      }
      candidatePort += 1;
    }
  }
}

export function parseArguments(args) {
  let port = DEFAULT_PORT;
  let explicitPort = false;
  let openBrowser = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--open') openBrowser = true;
    else if (argument === '--help' || argument === '-h') help = true;
    else if (argument === '--port' || argument.startsWith('--port=')) {
      const value = argument === '--port' ? args[++index] : argument.slice('--port='.length);
      if (explicitPort || !/^\d+$/.test(value ?? '') || Number(value) < 1 || Number(value) > 65535) {
        throw new Error('Use one --port NUMBER argument, with a port between 1 and 65535.');
      }
      port = Number(value);
      explicitPort = true;
    } else throw new Error(`Unknown argument: ${argument}. Use --help for usage.`);
  }
  return { port, explicitPort, openBrowser, help };
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.warn(`Could not open the browser automatically. Open ${url} manually.`));
  child.unref();
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node serve.mjs [--open] [--port NUMBER]\nServes dist on 127.0.0.1. Default: first free port from 5182.\n--open opens the URL in your default browser.');
    return;
  }
  const projectDir = dirname(fileURLToPath(import.meta.url));
  let version = 'unknown';
  try {
    const manifest = JSON.parse(await readFile(resolve(projectDir, 'package.json'), 'utf8'));
    if (typeof manifest.version === 'string') version = manifest.version;
  } catch { /* The build can still run if optional version metadata is unavailable. */ }
  const server = await createStaticServer(projectDir);
  const url = await listenStaticServer(server, options);
  console.log(`Portside ${version}\nFolder: ${projectDir}\nURL: ${url}\nPress Ctrl+C to stop.`);
  server.on('error', (error) => console.error(`Server error: ${error.message}`));
  const stop = () => {
    server.close();
    server.closeAllConnections();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (options.openBrowser) openBrowser(url);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Cannot start Portside: ${error.message}`);
    process.exitCode = 1;
  });
}
