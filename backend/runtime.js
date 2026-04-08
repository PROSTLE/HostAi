/**
 * runtime.js — Local process runtime for Node.js and Python backends.
 * - .py files  → launched with: python -m uvicorn <module>:app --port <PORT>
 * - .js files  → launched with: node <file>
 * No Docker required. Each site gets a unique port (9100+).
 */
import { execFile, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const runtimeMap = new Map(); // siteId → { process, port, lang, ... }
let nextPort = 9100;

// ── Utilities ─────────────────────────────────────────────────────────────────

function safeBackendFile(backendFile) {
  const normalized = String(backendFile || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const safe = path.posix.normalize(normalized);
  if (!safe || safe === '.' || safe.startsWith('..') || path.posix.isAbsolute(safe)) return null;
  return safe;
}

function allocatePort() {
  return nextPort++;
}

async function findExecutable(candidates) {
  for (const cmd of candidates) {
    try {
      await new Promise((resolve, reject) => {
        execFile(cmd, ['--version'], { windowsHide: true, timeout: 3000 }, (err) =>
          err ? reject(err) : resolve()
        );
      });
      return cmd;
    } catch {}
  }
  return null;
}

// ── Docker (kept for status check compat) ────────────────────────────────────

export async function isDockerAvailable() {
  return !!(await findExecutable(['docker']));
}

// ── Runtime status ────────────────────────────────────────────────────────────

export async function getRuntimeStatus(siteId) {
  const info = runtimeMap.get(siteId);
  if (!info) {
    return { running: false, siteId, message: 'Not started' };
  }

  const alive = info.process && !info.process.killed && info.process.exitCode === null;
  return {
    running: alive,
    siteId,
    port: info.port,
    lang: info.lang,
    backendFile: info.backendFile,
    startedAt: info.startedAt,
    proxyTarget: `http://localhost:${info.port}`,
    message: alive ? `Running on port ${info.port}` : 'Stopped',
  };
}

/** Returns the local proxy URL for a running site backend, or null */
export function getRuntimeProxyTarget(siteId) {
  const info = runtimeMap.get(siteId);
  if (!info) return null;
  const alive = info.process && !info.process.killed && info.process.exitCode === null;
  return alive ? `http://localhost:${info.port}` : null;
}

// ── Start ─────────────────────────────────────────────────────────────────────

export async function startRuntimeForSite({ siteId, siteDir, backendFile }) {
  const safeEntry = safeBackendFile(backendFile);
  if (!safeEntry) throw new Error('Invalid backend entry file');

  // Stop any existing runtime for this site
  await stopRuntimeForSite(siteId);

  const ext = path.extname(safeEntry).toLowerCase();
  const port = allocatePort();
  const fullEntryPath = path.join(siteDir, safeEntry);

  if (!fs.existsSync(fullEntryPath)) {
    throw new Error(`Backend file not found: ${safeEntry}`);
  }

  let proc;
  let lang;

  if (ext === '.py') {
    // ── Python / FastAPI via uvicorn ────────────────────────────────────────
    lang = 'python';

    const backendDir = path.dirname(fullEntryPath);
    const backendFileName = path.basename(safeEntry, '.py');
    const modulePath = backendFileName;

    // Try venv python first, then system python
    const venvPython = path.join(backendDir, 'venv', 'Scripts', 'python.exe');
    const venvPython3 = path.join(backendDir, 'venv', 'bin', 'python3');
    let pythonCmd;

    if (fs.existsSync(venvPython)) {
      pythonCmd = venvPython;
    } else if (fs.existsSync(venvPython3)) {
      pythonCmd = venvPython3;
    } else {
      pythonCmd = await findExecutable(['python', 'python3']);
    }

    if (!pythonCmd) throw new Error('Python not found. Install Python 3.8+ and try again.');

    console.log(`[RUNTIME] Starting Python backend: ${modulePath} from ${backendDir} on port ${port}`);

    proc = spawn(
      pythonCmd,
      ['-m', 'uvicorn', `${modulePath}:app`, '--host', '0.0.0.0', '--port', String(port)],
      {
        cwd: backendDir,
        windowsHide: true,
        env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONPATH: backendDir },
      }
    );

  } else if (ext === '.js' || ext === '.mjs') {
    // ── Node.js ─────────────────────────────────────────────────────────────
    lang = 'node';
    const nodeCmd = await findExecutable(['node']);
    if (!nodeCmd) throw new Error('Node.js not found.');

    console.log(`[RUNTIME] Starting Node.js backend: ${safeEntry} on port ${port}`);

    proc = spawn(nodeCmd, [safeEntry], {
      cwd: siteDir,
      windowsHide: true,
      env: { ...process.env, PORT: String(port) },
    });

  } else {
    throw new Error(`Unsupported backend file type: ${ext}. Use .py or .js`);
  }

  // Log output
  proc.stdout?.on('data', (d) => console.log(`[RT:${siteId}] ${d.toString().trim()}`));
  proc.stderr?.on('data', (d) => console.error(`[RT:${siteId}] ${d.toString().trim()}`));
  proc.on('exit', (code) => {
    console.log(`[RUNTIME] Site ${siteId} backend exited (code ${code})`);
  });

  const record = {
    siteId,
    siteDir,
    backendFile: safeEntry,
    process: proc,
    port,
    lang,
    startedAt: new Date().toISOString(),
  };

  runtimeMap.set(siteId, record);

  // Give the process a moment to start
  await new Promise((r) => setTimeout(r, 1500));

  return {
    success: true,
    siteId,
    port,
    lang,
    backendFile: safeEntry,
    proxyTarget: `http://localhost:${port}`,
    startedAt: record.startedAt,
  };
}

// ── Stop ──────────────────────────────────────────────────────────────────────

export async function stopRuntimeForSite(siteId) {
  const info = runtimeMap.get(siteId);

  if (info?.process) {
    try {
      info.process.kill('SIGTERM');
      // Give it 2s to exit gracefully, then SIGKILL
      await new Promise((r) => setTimeout(r, 2000));
      if (!info.process.killed) info.process.kill('SIGKILL');
    } catch {}
  }

  runtimeMap.delete(siteId);

  return { success: true, siteId, message: 'Runtime stopped' };
}
