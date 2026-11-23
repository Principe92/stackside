// .NET side of the bridge: speaks the Debug Adapter Protocol to netcoredbg.
import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, basename, isAbsolute } from 'node:path';
import { snippet } from './sourcemap.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => new Promise((res) => execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => res({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
const EXE = process.platform === 'win32' ? 'netcoredbg.exe' : 'netcoredbg';

/** Where netcoredbg may be: an override, the plugin's vendor folder, the data folder, PATH. */
export function findNetcoredbg({ pluginRoot, dataDir }) {
  const candidates = [
    process.env.STACKSIDE_NETCOREDBG,
    join(pluginRoot, 'vendor', 'netcoredbg', EXE),
    join(dataDir, 'netcoredbg', EXE),
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  for (const dir of String(process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':')) {
    const p = join(dir, EXE);
    if (dir && existsSync(p)) return p;
  }
  return null;
}

/** Downloads Samsung's netcoredbg (MIT) release for this machine into dataDir/netcoredbg. */
export async function installNetcoredbg({ dataDir, version }) {
  const asset = process.platform === 'win32' ? 'netcoredbg-win64.zip'
    : process.platform === 'darwin' ? 'netcoredbg-osx-arm64.zip'
    : process.arch === 'arm64' ? 'netcoredbg-linux-arm64.tar.gz' : 'netcoredbg-linux-amd64.tar.gz';
  let tag = version;
  if (!tag) {
    const r = await fetch('https://api.github.com/repos/Samsung/netcoredbg/releases/latest', { headers: { 'User-Agent': 'stackside', Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error('could not read the latest netcoredbg release: HTTP ' + r.status);
    tag = (await r.json()).tag_name;
  }
  const url = `https://github.com/Samsung/netcoredbg/releases/download/${tag}/${asset}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'stackside' } });
  if (!res.ok) throw new Error(`download failed (${url}): HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const dir = join(dataDir, 'download');
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const archive = join(dir, asset);
  writeFileSync(archive, bytes);
  rmSync(join(dataDir, 'netcoredbg'), { recursive: true, force: true });
  const x = process.platform === 'win32'
    ? await run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dataDir}' -Force`])
    : asset.endsWith('.zip') ? await run('unzip', ['-o', archive, '-d', dataDir]) : await run('tar', ['-xzf', archive, '-C', dataDir]);
  rmSync(dir, { recursive: true, force: true });
  if (x.code !== 0) throw new Error('unpacking failed: ' + (x.stderr || x.stdout));
  const exe = join(dataDir, 'netcoredbg', EXE);
  if (!existsSync(exe)) throw new Error('netcoredbg not found after unpacking ' + asset);
  const v = await run(exe, ['--version']);
  return { installed: exe, version: v.stdout.split('\n')[0].trim(), from: url, bytes: bytes.length };
}

class Dap {
  constructor(exe) {
    this.proc = spawn(exe, ['--interpreter=vscode'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.seq = 0; this.pending = new Map(); this.handlers = new Set(); this.buf = Buffer.alloc(0);
    this.proc.stdout.on('data', (d) => this.#data(d));
    this.proc.stderr.on('data', (d) => this.onStderr?.(String(d)));
    this.proc.on('exit', (code) => { this.exited = true; for (const p of this.pending.values()) p.reject(new Error('netcoredbg exited ' + code)); this.pending.clear(); this.onExit?.(code); });
  }
  #data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const hdrEnd = this.buf.indexOf('\r\n\r\n');
      if (hdrEnd < 0) return;
      const m = /Content-Length:\s*(\d+)/i.exec(this.buf.slice(0, hdrEnd).toString());
      if (!m) { this.buf = this.buf.slice(hdrEnd + 4); continue; }
      const len = Number(m[1]);
      if (this.buf.length < hdrEnd + 4 + len) return;
      const msg = JSON.parse(this.buf.slice(hdrEnd + 4, hdrEnd + 4 + len).toString('utf8'));
      this.buf = this.buf.slice(hdrEnd + 4 + len);
      if (msg.type === 'response') {
        const p = this.pending.get(msg.request_seq);
        if (p) { this.pending.delete(msg.request_seq); clearTimeout(p.timer); msg.success ? p.resolve(msg.body || {}) : p.reject(new Error(msg.message || msg.body?.error?.format || 'request failed')); }
      } else if (msg.type === 'event') {
        for (const h of this.handlers) { try { h(msg); } catch { /* */ } }
      }
    }
  }
  request(command, args = {}, timeoutMs = 30000) {
    const seq = ++this.seq;
    const body = Buffer.from(JSON.stringify({ seq, type: 'request', command, arguments: args }), 'utf8');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error(command + ' timed out')); }, timeoutMs);
      this.pending.set(seq, { resolve, reject, timer });
      this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      this.proc.stdin.write(body);
    });
  }
  on(h) { this.handlers.add(h); return () => this.handlers.delete(h); }
  kill() { try { this.proc.kill(); } catch { /* */ } }
}

export class DotNet {
  constructor({ findExe, log }) {
    this.findExe = findExe; this.log = log || (() => {});
    this.dap = null; this.state = 'idle'; // idle | building | starting | running | paused | exited
    this.project = null; this.root = null; this.program = null; this.pid = null;
    this.output = []; this.breakpoints = []; this.nextBp = 1; this.exceptions = 'user-unhandled';
    this.paused = null; this.threadId = null; this.exitCode = null;
  }

  // ---------- session ----------
  async launch({ project, profile, args = [], env = {}, stopAtEntry = false, build = true }) {
    await this.stop();
    this.#exe();
    const csproj = findCsproj(project);
    this.project = csproj; this.root = findRoot(dirname(csproj));
    this.output = []; this.exitCode = null;
    if (build) {
      this.state = 'building';
      const b = await run('dotnet', ['build', csproj, '-c', 'Debug', '-nologo', '-v', 'q', '-clp:NoSummary;ErrorsOnly']);
      if (b.code !== 0) { this.state = 'idle'; throw new Error('build failed:\n' + (b.stdout + b.stderr).trim().split('\n').slice(-25).join('\n')); }
    }
    const tp = await run('dotnet', ['msbuild', csproj, '-nologo', '-getProperty:TargetPath', '-p:Configuration=Debug']);
    const dll = tp.stdout.trim().split(/\r?\n/).pop();
    if (!dll || !existsSync(dll)) throw new Error('could not find the built assembly (' + dll + ')');
    this.program = dll;
    const ls = launchProfile(dirname(csproj), profile);
    const fullEnv = { ...ls.env, ...env };
    if (ls.urls && !fullEnv.ASPNETCORE_URLS) fullEnv.ASPNETCORE_URLS = ls.urls;
    await this.#start('launch', {
      program: process.platform === 'win32' ? 'dotnet.exe' : 'dotnet', args: [dll, ...args], cwd: dirname(csproj),
      env: fullEnv, stopAtEntry, justMyCode: true, enableStepFiltering: true,
    });
    return { ...this.status(), launched: basename(dll), profile: ls.name, urls: fullEnv.ASPNETCORE_URLS, env: Object.keys(fullEnv) };
  }

  async attach({ processId, processName, project }) {
    await this.stop();
    this.#exe();
    let pid = processId;
    if (!pid && processName) pid = await findPid(processName);
    if (!pid) throw new Error('no process to attach to');
    if (project) { this.project = findCsproj(project); this.root = findRoot(dirname(this.project)); }
    this.output = []; this.exitCode = null; this.pid = pid;
    await this.#start('attach', { processId: Number(pid), justMyCode: true });
    return { ...this.status(), attached: pid };
  }

  #exe() {
    const exe = this.findExe();
    if (!exe) throw new Error('netcoredbg (the .NET debugger) is not installed yet. Run the dotnet_setup tool once to download it (about 3.5 MB, MIT licensed, from github.com/Samsung/netcoredbg), or set STACKSIDE_NETCOREDBG to an existing netcoredbg.');
    return exe;
  }

  async #start(kind, args) {
    const exe = this.#exe();
    this.state = 'starting';
    const dap = (this.dap = new Dap(exe));
    dap.onStderr = (t) => this.#out('debugger', t);
    dap.onExit = () => { if (this.dap === dap) { this.state = 'exited'; this.paused = null; } };
    const initialized = new Promise((r) => dap.on((m) => m.event === 'initialized' && r()));
    dap.on((m) => this.#onEvent(m));
    await dap.request('initialize', { clientID: 'stackside', adapterID: 'coreclr', linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path', supportsVariableType: true });
    const started = dap.request(kind, args, 60000);
    await Promise.race([initialized, started.then(() => initialized)]);
    for (const file of new Set(this.breakpoints.map((b) => b.path))) await this.#sendFile(file);
    await this.#sendExceptions();
    await dap.request('configurationDone');
    await started;
    if (this.state === 'starting') this.state = 'running';
  }

  async stop() {
    if (!this.dap) return { stopped: false };
    const dap = this.dap;
    try { await dap.request('disconnect', { terminateDebuggee: !this.pid || this.program != null }, 5000); } catch { /* */ }
    await sleep(200); dap.kill();
    this.dap = null; this.state = 'idle'; this.paused = null; this.pid = null; this.program = null;
    return { stopped: true };
  }

  #out(category, text) {
    for (const line of String(text).split(/\r?\n/)) {
      if (!line.trim()) continue;
      this.output.push({ t: Date.now(), category, text: line.slice(0, 2000) });
    }
    if (this.output.length > 1500) this.output.splice(0, this.output.length - 1500);
  }

  async #onEvent(m) {
    const b = m.body || {};
    switch (m.event) {
      case 'output': this.#out(b.category || 'console', b.output); break;
      case 'process': this.pid = this.pid || b.systemProcessId; break;
      case 'stopped': this.state = 'paused'; this.threadId = b.threadId; await this.#capturePause(b); break;
      case 'continued': if (b.allThreadsContinued !== false || b.threadId === this.threadId) { this.state = 'running'; this.paused = null; } break;
      case 'exited': this.exitCode = b.exitCode; break;
      case 'terminated': this.state = 'exited'; this.paused = null; break;
      case 'breakpoint': {
        const bp = this.breakpoints.find((x) => x.dapId === b.breakpoint?.id);
        if (bp) { bp.verified = b.breakpoint.verified; if (b.breakpoint.line) bp.actualLine = b.breakpoint.line; }
        break;
      }
    }
  }

  async #frames(threadId, levels = 30) {
    const st = await this.dap.request('stackTrace', { threadId, startFrame: 0, levels });
    return st.stackFrames.map((f) => ({ id: f.id, fn: f.name, file: f.source?.path ? this.#rel(f.source.path) : null, path: f.source?.path, line: f.line, column: f.column }));
  }

  /**
   * A pause (break all) is reported on whichever thread the runtime picked, often an idle thread-pool worker.
   * Show the thread that is in the user's code instead (the main thread when none is), and list the others.
   */
  async #pickThread(b) {
    let threads = [];
    try { ({ threads } = await this.dap.request('threads')); } catch { return null; }
    const seen = [];
    for (const t of threads.slice(0, 64)) {
      let frames = [];
      // deep: a blocked startup (e.g. an interactive sign-in) sits 70+ framework frames above Program.cs
      try { frames = await this.#frames(t.id, 200); } catch { /* thread gone or not stoppable */ }
      seen.push({ id: t.id, name: t.name, frames });
    }
    const pick = seen.find((t) => t.frames.some((f) => f.file)) || seen.find((t) => /main thread/i.test(t.name || '') && t.frames.length)
      || seen.find((t) => t.frames.length) || seen[0];
    const summary = seen.map((t) => {
      const top = t.frames.find((f) => f.file) || t.frames[0];
      return { id: t.id, name: t.name || undefined, at: top ? (top.file ? `${top.fn} (${top.file}:${top.line})` : top.fn) : null };
    });
    return pick ? { threadId: pick.id, frames: pick.frames, threads: summary, reported: b.threadId } : null;
  }

  async #capturePause(b) {
    const p = { at: Date.now(), reason: b.reason, text: b.text, threadId: b.threadId, frames: [], locals: [] };
    try {
      const picked = /^(pause|interrupt)$/i.test(b.reason || '') ? await this.#pickThread(b) : null;
      if (picked) { p.threadId = picked.threadId; this.threadId = picked.threadId; p.frames = picked.frames; p.threads = picked.threads; }
      else p.frames = await this.#frames(b.threadId);
      // locals only make sense in a frame with source; a native frame answers 'variables' with E_FAIL
      const top = p.frames.find((f) => f.file) || p.frames[0];
      p.frame = Math.max(0, p.frames.indexOf(top));
      if (top?.file) {
        try { p.locals = await this.#scopeVars(top.id); } catch (e) { p.localsError = e.message; }
      }
      if (b.reason === 'exception') {
        try { const ex = await this.dap.request('exceptionInfo', { threadId: b.threadId }); p.exception = { id: ex.exceptionId, message: ex.description || ex.details?.message, type: ex.details?.typeName, stack: ex.details?.stackTrace?.split('\n').slice(0, 8).join('\n') }; } catch { /* */ }
      }
      const hit = this.breakpoints.find((x) => x.path && top?.path && samePath(x.path, top.path) && (x.actualLine || x.line) === top.line);
      if (hit) p.breakpoint = hit.id;
    } catch (e) { p.error = e.message; }
    this.paused = p;
    this.onPause?.(p);
  }

  async #scopeVars(frameId, depthCap = 60) {
    const out = [];
    const { scopes } = await this.dap.request('scopes', { frameId });
    for (const sc of scopes.slice(0, 2)) {
      const { variables } = await this.dap.request('variables', { variablesReference: sc.variablesReference });
      for (const v of variables.slice(0, depthCap)) out.push({ scope: sc.name, name: v.name, type: v.type, value: String(v.value).slice(0, 400), ref: v.variablesReference || undefined });
    }
    return out;
  }

  #rel(p) {
    if (!this.root) return p;
    const n = p.replace(/\\/g, '/'), r = this.root.replace(/\\/g, '/').replace(/\/$/, '') + '/';
    return n.toLowerCase().startsWith(r.toLowerCase()) ? n.slice(r.length) : n;
  }

  // ---------- breakpoints ----------
  #resolveFile(file) {
    if (isAbsolute(file) && existsSync(file)) return resolve(file);
    const base = this.root || process.cwd();
    const direct = resolve(base, file);
    if (existsSync(direct)) return direct;
    const want = file.replace(/\\/g, '/').toLowerCase();
    const hits = [];
    walk(base, (p) => { const n = p.replace(/\\/g, '/').toLowerCase(); if (n.endsWith('/' + want) || basename(n) === want) hits.push(p); }, 6);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new Error(`"${file}" matches several files:\n` + hits.slice(0, 8).join('\n'));
    throw new Error(`cannot find ${file} under ${base}` + (this.root ? '' : ' (launch or pass `project` first so relative paths resolve)'));
  }

  async setBreakpoint({ file, line, condition, project }) {
    if (project && !this.root) { this.project = findCsproj(project); this.root = findRoot(dirname(this.project)); }
    const path = this.#resolveFile(file);
    const bp = { id: 'cs' + this.nextBp++, path, file: this.#rel(path), line: Number(line), condition, verified: null };
    this.breakpoints.push(bp);
    if (this.dap && !this.dap.exited) await this.#sendFile(path);
    const { dapId, ...pub } = bp;
    return { ...pub, note: this.dap ? undefined : 'saved; applied when you launch or attach' };
  }

  async removeBreakpoint(id) {
    const victims = id === 'all' ? [...this.breakpoints] : this.breakpoints.filter((b) => b.id === id);
    if (!victims.length) throw new Error('no breakpoint ' + id);
    this.breakpoints = this.breakpoints.filter((b) => !victims.includes(b));
    if (this.dap) for (const f of new Set(victims.map((v) => v.path))) await this.#sendFile(f);
    return { removed: victims.map((v) => v.id) };
  }

  async #sendFile(path) {
    const list = this.breakpoints.filter((b) => samePath(b.path, path));
    const r = await this.dap.request('setBreakpoints', { source: { path, name: basename(path) }, breakpoints: list.map((b) => ({ line: b.line, condition: b.condition || undefined })), lines: list.map((b) => b.line) });
    (r.breakpoints || []).forEach((rb, i) => { const bp = list[i]; if (!bp) return; bp.dapId = rb.id; bp.verified = rb.verified; if (rb.line) bp.actualLine = rb.line; if (rb.message) bp.message = rb.message; });
  }

  async setExceptions(mode) {
    this.exceptions = mode;
    if (this.dap) await this.#sendExceptions();
    return { exceptions: mode };
  }
  async #sendExceptions() {
    const filters = this.exceptions === 'all' ? ['all'] : this.exceptions === 'none' ? [] : ['user-unhandled'];
    try { await this.dap.request('setExceptionBreakpoints', { filters }); } catch (e) { this.log('exceptions: ' + e.message); }
  }

  listBreakpoints() { return this.breakpoints.map(({ id, file, line, actualLine, condition, verified, message }) => ({ id, file, line: actualLine || line, condition, verified, message })); }

  // ---------- execution ----------
  async step(kind) {
    if (!this.dap) throw new Error('no .NET debug session; launch or attach first');
    if (kind === 'pause') {
      const { threads } = await this.dap.request('threads');
      await this.dap.request('pause', { threadId: threads[0]?.id ?? 0 });
      await this.#waitPause();
      return this.pauseState();
    }
    if (this.state !== 'paused') return { note: 'not paused' };
    const cmd = { continue: 'continue', over: 'next', into: 'stepIn', out: 'stepOut' }[kind];
    if (!cmd) throw new Error('unknown step ' + kind);
    const before = this.paused?.at || 0;
    this.paused = null; this.state = 'running';
    await this.dap.request(cmd, { threadId: this.threadId });
    if (kind === 'continue') return { resumed: true };
    await this.#waitPause(before);
    return this.pauseState();
  }

  async #waitPause(after = 0, ms = 5000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (this.paused && this.paused.at > after) return; await sleep(60); }
  }

  async variables(ref) {
    if (!this.dap) throw new Error('no session');
    const { variables } = await this.dap.request('variables', { variablesReference: Number(ref) });
    return variables.slice(0, 200).map((v) => ({ name: v.name, type: v.type, value: String(v.value).slice(0, 1000), ref: v.variablesReference || undefined }));
  }

  async evaluate(expression, frameIndex) {
    if (!this.dap) throw new Error('no session');
    const frame = this.paused?.frames?.[frameIndex ?? this.paused?.frame ?? 0];
    const r = await this.dap.request('evaluate', { expression, frameId: frame?.id, context: 'repl' });
    return { value: r.result, type: r.type, ref: r.variablesReference || undefined };
  }

  outputLog({ since = 0, limit = 120, filter } = {}) {
    let rows = this.output.filter((o) => o.t > since);
    if (filter) rows = rows.filter((o) => o.text.toLowerCase().includes(String(filter).toLowerCase()));
    return rows.slice(-limit);
  }

  /** `frame`: show that call-stack frame's locals and source (and use it for dotnet_eval) until the next pause. */
  async pauseState(frame) {
    if (!this.paused) return { paused: false, state: this.state };
    const pick = this.paused.frames[frame];
    if (frame != null && frame !== this.paused.frame && pick) {
      this.paused.frame = frame; this.paused.locals = []; delete this.paused.localsError;
      if (pick.file) { try { this.paused.locals = await this.#scopeVars(pick.id); } catch (e) { this.paused.localsError = e.message; } }
    }
    const at = this.paused.frames[this.paused.frame ?? 0];
    let source = null;
    if (at?.path) { try { source = snippet(readFileSync(at.path, 'utf8'), at.line, at.path); } catch { /* file moved or unreadable */ } }
    const { frames, threadId, ...rest } = this.paused;
    rest.source = source;
    let shown = frames.map(({ id, path, ...f }, index) => ({ index, ...f }));
    let hiddenFrames;
    if (shown.length > 30) { // long framework stacks: keep the top and every frame in the user's code
      const keep = shown.filter((f) => f.index < 12 || f.file);
      hiddenFrames = shown.length - keep.length; shown = keep;
    }
    return { paused: true, ...rest, thread: threadId, frames: shown, hiddenFrames };
  }

  status() {
    return {
      state: this.state, project: this.project ? this.#rel(this.project) : null, pid: this.pid, exitCode: this.exitCode,
      paused: this.paused ? { reason: this.paused.reason, at: this.paused.frames.find((f) => f.file) || this.paused.frames[0], exception: this.paused.exception?.type } : null,
      breakpoints: this.breakpoints.length,
      debugger: this.findExe() ? 'installed' : 'missing (run dotnet_setup)',
    };
  }
}

// ---------- helpers ----------
function findCsproj(p) {
  if (!p) throw new Error('pass `project`: a .csproj path or its folder');
  const abs = resolve(p);
  if (abs.endsWith('.csproj') && existsSync(abs)) return abs;
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    const here = readdirSync(abs).filter((f) => f.endsWith('.csproj'));
    if (here.length === 1) return join(abs, here[0]);
    // a solution folder: prefer the single web project
    const found = [];
    walk(abs, (f) => { if (f.endsWith('.csproj')) found.push(f); }, 3);
    const web = found.filter((f) => { try { return /Sdk="Microsoft\.NET\.Sdk\.Web"/.test(readFileSync(f, 'utf8')); } catch { return false; } });
    if (web.length === 1) return web[0];
    if (found.length) throw new Error('several projects; pick one:\n' + (web.length ? web : found).join('\n'));
  }
  throw new Error('no .csproj at ' + p);
}

function findRoot(dir) {
  let d = dir;
  for (let i = 0; i < 4; i++) {
    if (readdirSync(d).some((f) => f.endsWith('.sln') || f.endsWith('.slnx') || f === '.git')) return d;
    const up = dirname(d); if (up === d) break; d = up;
  }
  return dirname(dir);
}

function launchProfile(projDir, name) {
  const f = join(projDir, 'Properties', 'launchSettings.json');
  if (!existsSync(f)) return { env: { ASPNETCORE_ENVIRONMENT: 'Development' } };
  try {
    const j = JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, ''));
    const entries = Object.entries(j.profiles || {});
    const [pname, prof] = (name && entries.find(([n]) => n === name)) || entries.find(([, p]) => p.commandName === 'Project') || entries[0] || [];
    if (!prof) return { env: {} };
    return { name: pname, env: { ...(prof.environmentVariables || {}) }, urls: prof.applicationUrl };
  } catch { return { env: { ASPNETCORE_ENVIRONMENT: 'Development' } }; }
}

function walk(dir, fn, depth) {
  if (depth < 0) return;
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || ['bin', 'obj', 'node_modules', 'dist'].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, fn, depth - 1); else fn(p);
  }
}

function samePath(a, b) { return String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase(); }

async function findPid(name) {
  const safe = String(name).replace(/['"`$;|&]/g, '');
  if (process.platform !== 'win32') { const r = await run('pgrep', ['-f', safe]); return Number(r.stdout.split('\n')[0]) || null; }
  const r = await run('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*${safe}*' -or $_.CommandLine -like '*${safe}*' } | Where-Object { $_.Name -ne 'powershell.exe' -and $_.ProcessId -ne $PID } | Select-Object -First 1).ProcessId`]);
  return Number(r.stdout.trim()) || null;
}
