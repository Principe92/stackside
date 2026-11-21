// Chrome side of the bridge: launches a dedicated Chrome, drives it over the
// DevTools protocol, and debugs the page's TypeScript through source maps.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SourceMap, normPath } from './sourcemap.mjs';

const CHROME_CANDIDATES = [
  process.env.STACKSIDE_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean);

const OFFSCREEN = { left: -32000, top: -32000 };
const VIEW = { width: 1280, height: 860 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Set();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer); this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers) { try { h(msg); } catch (e) { /* ignore */ } }
      }
    });
    ws.addEventListener('close', () => { this.closed = true; for (const p of this.pending.values()) p.reject(new Error('Chrome connection closed')); this.pending.clear(); });
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error('cannot connect to ' + url)), { once: true });
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 15000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timed out')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
  on(h) { this.handlers.add(h); return () => this.handlers.delete(h); }
  close() { try { this.ws.close(); } catch { /* */ } }
}

export class Web {
  constructor({ dataDir, log }) {
    this.dataDir = dataDir; this.log = log || (() => {});
    this.port = Number(process.env.STACKSIDE_CHROME_PORT || 9333);
    this.cdp = null; this.session = null; this.targetId = null; this.windowId = null;
    this.visible = false; this.url = ''; this.title = '';
    this.console = []; this.network = new Map(); this.netOrder = [];
    this.scripts = new Map(); // scriptId -> { url, sourceMapURL, map?: SourceMap|null, loading?: Promise }
    this.breakpoints = []; // { id, file, line, condition, cdpIds: [{scriptId, breakpointId}], resolved: string|null }
    this.nextBp = 1;
    this.paused = null; // { reason, frames, locals, exception }
    this.pauseOnExceptions = 'none';
    this.lastFrame = null;
  }

  get running() { return !!(this.cdp && !this.cdp.closed && this.session); }

  async ensure() {
    if (this.running) return;
    let version = await this.#version();
    if (!version) {
      const exe = CHROME_CANDIDATES.find((p) => existsSync(p));
      if (!exe) throw new Error('Chrome not found. Set STACKSIDE_CHROME to the browser executable.');
      const profile = join(this.dataDir, 'chrome-profile');
      mkdirSync(profile, { recursive: true });
      const args = [
        `--remote-debugging-port=${this.port}`, `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', '--disable-features=CalculateNativeWinOcclusion',
        '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
        `--window-position=${OFFSCREEN.left},${OFFSCREEN.top}`, `--window-size=${VIEW.width},${VIEW.height}`,
        'about:blank',
      ];
      this.chrome = spawn(exe, args, { detached: true, stdio: 'ignore' });
      this.chrome.unref();
      for (let i = 0; i < 50 && !version; i++) { await sleep(200); version = await this.#version(); }
      if (!version) throw new Error('Chrome did not open its debugging port ' + this.port);
      this.visible = false;
    }
    this.cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    const { targetInfos } = await this.cdp.send('Target.getTargets');
    let page = targetInfos.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
    if (!page) { const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' }); page = { targetId }; }
    await this.#attach(page.targetId);
    this.cdp.on((m) => this.#onEvent(m));
  }

  async #version() {
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(800) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  async #attach(targetId) {
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    this.session = sessionId; this.targetId = targetId;
    this.scripts.clear(); this.paused = null;
    const s = (m, p) => this.cdp.send(m, p, sessionId);
    await Promise.all([
      s('Page.enable'), s('Runtime.enable'), s('Network.enable'), s('Log.enable'),
      s('Debugger.enable', { maxScriptsCacheSize: 100_000_000 }),
    ]);
    await s('Debugger.setPauseOnExceptions', { state: this.pauseOnExceptions });
    await s('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    try { const w = await this.cdp.send('Browser.getWindowForTarget', { targetId }); this.windowId = w.windowId; } catch { /* */ }
    for (const bp of this.breakpoints) bp.cdpIds = [];
  }

  send(method, params, timeoutMs) { return this.cdp.send(method, params, this.session, timeoutMs); }

  // ---------- events ----------
  #onEvent(m) {
    if (m.sessionId && m.sessionId !== this.session) {
      return;
    }
    const p = m.params || {};
    switch (m.method) {
      case 'Target.targetCrashed': case 'Target.detachedFromTarget': if (!m.sessionId || p.sessionId === this.session) this.session = null; break;
      case 'Page.frameNavigated': if (!p.frame.parentId) { this.url = p.frame.url; } break;
      case 'Page.domContentEventFired': this.#refreshTitle(); break;
      case 'Runtime.consoleAPICalled':
        this.#pushConsole(p.type, p.args.map(fmtRemote).join(' '), p.stackTrace?.callFrames?.[0]); break;
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails;
        this.#pushConsole('exception', (d.exception?.description || d.text || '').split('\n').slice(0, 6).join('\n'), d.stackTrace?.callFrames?.[0]); break;
      }
      case 'Log.entryAdded': this.#pushConsole(p.entry.level, p.entry.text + (p.entry.url ? ` (${p.entry.url})` : '')); break;
      case 'Network.requestWillBeSent': {
        const r = { id: p.requestId, method: p.request.method, url: p.request.url, type: p.type, start: p.timestamp, status: null, ms: null, postData: p.request.postData?.slice(0, 2000) };
        this.network.set(p.requestId, r); this.netOrder.push(p.requestId);
        if (this.netOrder.length > 400) this.network.delete(this.netOrder.shift());
        break;
      }
      case 'Network.responseReceived': { const r = this.network.get(p.requestId); if (r) { r.status = p.response.status; r.mime = p.response.mimeType; } break; }
      case 'Network.loadingFinished': { const r = this.network.get(p.requestId); if (r) r.ms = Math.round((p.timestamp - r.start) * 1000); break; }
      case 'Network.loadingFailed': { const r = this.network.get(p.requestId); if (r) { r.failed = p.errorText; r.ms = Math.round((p.timestamp - r.start) * 1000); } break; }
      case 'Debugger.scriptParsed': this.#onScript(p); break;
      case 'Debugger.paused': this.#onPaused(p); break;
      case 'Debugger.resumed': this.paused = null; break;
    }
  }

  #pushConsole(level, text, frame) {
    const where = frame ? ` @ ${shortUrl(frame.url)}:${frame.lineNumber + 1}` : '';
    this.console.push({ t: Date.now(), level, text: String(text).slice(0, 4000) + where });
    if (this.console.length > 500) this.console.shift();
  }

  async #refreshTitle() { try { const r = await this.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, 3000); this.title = r.result.value || ''; } catch { /* */ } }

  #onScript(p) {
    if (!p.url || !p.sourceMapURL || p.url.startsWith('chrome')) return;
    const entry = { url: p.url, sourceMapURL: p.sourceMapURL, map: null };
    this.scripts.set(p.scriptId, entry);
    entry.loading = this.#loadMap(entry).then(() => this.#applyBreakpoints(p.scriptId)).catch((e) => this.log('sourcemap ' + p.url + ': ' + e.message));
  }

  async #loadMap(entry) {
    const u = entry.sourceMapURL;
    let text;
    if (u.startsWith('data:')) {
      const comma = u.indexOf(',');
      const meta = u.slice(5, comma);
      text = meta.includes('base64') ? Buffer.from(u.slice(comma + 1), 'base64').toString('utf8') : decodeURIComponent(u.slice(comma + 1));
    } else {
      const abs = new URL(u, entry.url).href;
      const r = await fetch(abs, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      text = await r.text();
    }
    entry.map = new SourceMap(text, u);
  }

  async #mapsReady() { await Promise.all([...this.scripts.values()].map((s) => s.loading)); }

  async #applyBreakpoints(scriptId) {
    const s = this.scripts.get(scriptId);
    if (!s?.map) return;
    for (const bp of this.breakpoints) await this.#placeIn(bp, scriptId, s);
  }

  async #placeIn(bp, scriptId, s) {
    // By URL, so Chrome re-applies it to every later load of that script
    // (reloads, navigations) before the script runs.
    if (bp.cdpIds.some((c) => c.url === s.url)) return;
    const idx = s.map.findSource(bp.file);
    if (idx < 0) return;
    const gen = s.map.generatedFor(idx, bp.line - 1);
    if (!gen) return;
    try {
      const r = await this.send('Debugger.setBreakpointByUrl', { url: s.url, lineNumber: gen.line, columnNumber: gen.column, condition: bp.condition || undefined });
      bp.cdpIds.push({ url: s.url, scriptId, breakpointId: r.breakpointId });
      bp.resolved = `${shortPath(s.map.sources[idx])}:${gen.actualSourceLine + 1}`;
    } catch (e) {
      if (/already exists/i.test(e.message)) bp.cdpIds.push({ url: s.url, scriptId, breakpointId: null });
      else this.log('setBreakpoint: ' + e.message);
    }
  }

  async #onPaused(p) {
    const frames = [];
    for (const f of p.callFrames.slice(0, 25)) frames.push({ fn: f.functionName || '(anonymous)', ...this.#orig(f.location), callFrameId: f.callFrameId });
    let locals = [];
    try {
      const top = p.callFrames[0];
      for (const scope of top.scopeChain.filter((sc) => sc.type === 'local' || sc.type === 'block' || sc.type === 'closure').slice(0, 3)) {
        const { result } = await this.send('Runtime.getProperties', { objectId: scope.object.objectId, ownProperties: true, generatePreview: true }, 4000);
        for (const prop of result.slice(0, 40)) locals.push({ scope: scope.type, name: prop.name, value: fmtRemote(prop.value || {}) });
      }
      if (top.this && top.this.type === 'object') locals.unshift({ scope: 'this', name: 'this', value: fmtRemote(top.this) });
    } catch (e) { this.log('locals: ' + e.message); }
    const hitBp = this.breakpoints.find((bp) => bp.cdpIds.some((c) => (p.hitBreakpoints || []).includes(c.breakpointId)));
    this.paused = {
      at: Date.now(), reason: p.reason === 'other' && hitBp ? 'breakpoint' : p.reason,
      breakpoint: hitBp?.id, exception: p.reason === 'exception' ? fmtRemote(p.data || {}) : undefined,
      frames, locals,
    };
    this.onPause?.(this.paused);
  }

  #orig(loc) {
    const s = this.scripts.get(loc.scriptId);
    const o = s?.map?.originalFor(loc.lineNumber, loc.columnNumber || 0);
    if (o) return { file: shortPath(o.source), line: o.line + 1, column: o.column + 1 };
    return { file: shortUrl(s?.url || loc.scriptId), line: loc.lineNumber + 1, column: (loc.columnNumber || 0) + 1, generated: true };
  }

  // ---------- page control ----------
  async open(url) {
    await this.ensure();
    if (!/^[a-z]+:/i.test(url)) url = 'http://' + url;
    this.netOrder = []; this.network.clear();
    await this.send('Page.navigate', { url });
    await this.#waitLoad();
    await this.#refreshTitle();
    return this.status();
  }

  async #waitLoad(ms = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (this.paused) return;
      try {
        const r = await this.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, 2000);
        if (r.result.value === 'complete') { await sleep(300); return; }
      } catch { /* navigating */ }
      await sleep(200);
    }
  }

  async nav(action) {
    await this.ensure();
    if (action === 'reload') await this.send('Page.reload', {});
    else {
      const { currentIndex, entries } = await this.send('Page.getNavigationHistory');
      const e = entries[currentIndex + (action === 'back' ? -1 : 1)];
      if (e) await this.send('Page.navigateToHistoryEntry', { entryId: e.id });
    }
    await this.#waitLoad();
    await this.#refreshTitle();
    return this.status();
  }

  /** Bring the same Chrome window onto the screen (or put it back off-screen). */
  async show(visible) {
    await this.ensure();
    if (this.windowId == null) { const w = await this.cdp.send('Browser.getWindowForTarget', { targetId: this.targetId }); this.windowId = w.windowId; }
    await this.cdp.send('Browser.setWindowBounds', { windowId: this.windowId, bounds: { windowState: 'normal' } });
    const bounds = visible ? { left: 80, top: 40, width: VIEW.width, height: VIEW.height } : { ...OFFSCREEN, width: VIEW.width, height: VIEW.height };
    await this.cdp.send('Browser.setWindowBounds', { windowId: this.windowId, bounds });
    if (visible) await this.send('Page.bringToFront');
    this.visible = visible;
    return this.status();
  }

  async frame({ maxChars = 120000, width = 900 } = {}) {
    await this.ensure();
    const m = await this.send('Runtime.evaluate', { expression: 'JSON.stringify([innerWidth, innerHeight])', returnByValue: true }, 2500).catch(() => null);
    const [vw, vh] = m ? JSON.parse(m.result.value) : [this.lastFrame?.viewport?.[0] || VIEW.width, this.lastFrame?.viewport?.[1] || VIEW.height];
    let scale = Math.min(1, width / vw), quality = 60, shot;
    for (let i = 0; i < 5; i++) {
      shot = await this.send('Page.captureScreenshot', { format: 'jpeg', quality, clip: { x: 0, y: 0, width: vw, height: vh, scale }, captureBeyondViewport: false }, 6000);
      if (shot.data.length <= maxChars) break;
      if (quality > 35) quality -= 12; else scale *= 0.8;
    }
    this.lastFrame = { data: shot.data, width: Math.round(vw * scale), height: Math.round(vh * scale), viewport: [vw, vh], at: Date.now() };
    return this.lastFrame;
  }

  async screenshot() {
    await this.ensure();
    const shot = await this.send('Page.captureScreenshot', { format: 'png' }, 10000);
    return shot.data;
  }

  /** Numbered list of what can be clicked or typed into, plus the page's visible text. */
  async snapshot({ maxText = 4000 } = {}) {
    await this.ensure();
    const expr = `(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const sel = 'a[href],button,input,textarea,select,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[contenteditable=true],mat-option,[tabindex]:not([tabindex="-1"])';
      document.querySelectorAll('[data-dd-ref]').forEach((e) => e.removeAttribute('data-dd-ref'));
      const items = []; let n = 0;
      for (const el of document.querySelectorAll(sel)) {
        if (!vis(el) || n >= 150) continue;
        const ref = ++n; el.setAttribute('data-dd-ref', ref);
        const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.name || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
        const kind = el.tagName.toLowerCase() + (el.type ? '[' + el.type + ']' : '') + (el.getAttribute('role') ? '(' + el.getAttribute('role') + ')' : '');
        items.push(ref + ': ' + kind + ' "' + label + '"' + (el.disabled ? ' disabled' : ''));
      }
      return JSON.stringify({ url: location.href, title: document.title, items, text: document.body ? document.body.innerText.replace(/\\n{3,}/g, '\\n\\n').slice(0, ${maxText}) : '' });
    })()`;
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true }, 8000);
    return JSON.parse(r.result.value);
  }

  async #center(target) {
    const find = target.ref != null ? `document.querySelector('[data-dd-ref="${Number(target.ref)}"]')`
      : target.selector ? `document.querySelector(${JSON.stringify(target.selector)})`
      : target.text ? `(() => { const want = ${JSON.stringify(String(target.text).toLowerCase())}; const all = [...document.querySelectorAll('a,button,[role=button],[role=link],[role=tab],[role=menuitem],mat-option,label,input[type=submit],li,span,div')]; return all.find((e) => (e.innerText||e.value||'').trim().toLowerCase() === want) || all.find((e) => (e.innerText||e.value||'').trim().toLowerCase().includes(want) && e.children.length < 4); })()`
      : null;
    if (!find) return null;
    const expr = `(() => { const el = ${find}; if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName }); })()`;
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true }, 5000);
    if (!r.result.value) throw new Error('element not found: ' + JSON.stringify(target));
    return JSON.parse(r.result.value);
  }

  async click(target) {
    await this.ensure();
    let x = target.x, y = target.y;
    if (target.fx != null) { const [vw, vh] = this.lastFrame?.viewport || [VIEW.width, VIEW.height]; x = target.fx * vw; y = target.fy * vh; }
    if (x == null) { const c = await this.#center(target); x = c.x; y = c.y; }
    const base = { x, y, button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
    await sleep(350);
    return { clicked: { x: Math.round(x), y: Math.round(y) }, url: this.url };
  }

  async type({ text, ref, selector, clear, submit }) {
    await this.ensure();
    if (ref != null || selector) await this.click({ ref, selector });
    if (clear) {
      await this.send('Runtime.evaluate', { expression: `(() => { const el = document.activeElement; if (el && 'value' in el) { el.select ? el.select() : null; } })()` });
      await this.key('Backspace');
    }
    if (text) await this.send('Input.insertText', { text });
    if (submit) await this.key('Enter');
    return { typed: text?.length || 0 };
  }

  async key(key) {
    await this.ensure();
    const K = {
      Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Tab: { code: 'Tab', keyCode: 9 }, Escape: { code: 'Escape', keyCode: 27 },
      Backspace: { code: 'Backspace', keyCode: 8 }, Delete: { code: 'Delete', keyCode: 46 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 },
      ArrowUp: { code: 'ArrowUp', keyCode: 38 }, ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, ArrowRight: { code: 'ArrowRight', keyCode: 39 },
      PageDown: { code: 'PageDown', keyCode: 34 }, PageUp: { code: 'PageUp', keyCode: 33 }, Home: { code: 'Home', keyCode: 36 }, End: { code: 'End', keyCode: 35 }, Space: { code: 'Space', keyCode: 32, text: ' ' },
    }[key];
    if (!K) { await this.send('Input.insertText', { text: key }); return { key }; }
    const ev = { key: key === 'Space' ? ' ' : key, code: K.code, windowsVirtualKeyCode: K.keyCode, nativeVirtualKeyCode: K.keyCode };
    await this.send('Input.dispatchKeyEvent', { type: K.text ? 'keyDown' : 'rawKeyDown', ...ev, text: K.text });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
    await sleep(150);
    return { key };
  }

  async scroll(dy = 500, fx = 0.5, fy = 0.5) {
    await this.ensure();
    const [vw, vh] = this.lastFrame?.viewport || [VIEW.width, VIEW.height];
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: fx * vw, y: fy * vh, deltaX: 0, deltaY: dy });
    await sleep(200);
    return { scrolled: dy };
  }

  async evaluate(expression, frameIndex) {
    await this.ensure();
    let r;
    if (this.paused) {
      const f = this.paused.frames[frameIndex || 0];
      r = await this.send('Debugger.evaluateOnCallFrame', { callFrameId: f.callFrameId, expression, returnByValue: false, generatePreview: true });
    } else {
      r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: false, generatePreview: true, userGesture: true });
    }
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    if (r.result.objectId && r.result.type === 'object') {
      try {
        const j = await this.send('Runtime.callFunctionOn', { objectId: r.result.objectId, functionDeclaration: 'function(){ try { return JSON.stringify(this, null, 1).slice(0, 8000) } catch(e) { return String(this) } }', returnByValue: true });
        return { value: j.result.value };
      } catch { /* fall through */ }
    }
    return { value: fmtRemote(r.result) };
  }

  consoleLog({ since = 0, clear = false, limit = 80 } = {}) {
    const out = this.console.filter((c) => c.t > since).slice(-limit);
    if (clear) this.console = [];
    return out;
  }

  networkLog({ filter, onlyErrors, limit = 60 } = {}) {
    let rows = this.netOrder.map((id) => this.network.get(id)).filter(Boolean);
    rows = rows.filter((r) => r.type === 'XHR' || r.type === 'Fetch' || r.type === 'Document' || r.failed || (r.status && r.status >= 400));
    if (filter) rows = rows.filter((r) => r.url.includes(filter));
    if (onlyErrors) rows = rows.filter((r) => r.failed || (r.status && r.status >= 400));
    return rows.slice(-limit).map(({ start, ...r }) => r);
  }

  async responseBody(id) {
    await this.ensure();
    const r = await this.send('Network.getResponseBody', { requestId: id });
    return r.base64Encoded ? '(binary)' : r.body.slice(0, 20000);
  }

  // ---------- JS debugging ----------
  async setBreakpoint({ file, line, condition }) {
    await this.ensure();
    const bp = { id: 'js' + this.nextBp++, file, line: Number(line), condition, cdpIds: [], resolved: null };
    this.breakpoints.push(bp);
    await this.#mapsReady();
    for (const [scriptId, s] of this.scripts) if (s.map) await this.#placeIn(bp, scriptId, s);
    return { id: bp.id, file, line: bp.line, resolved: bp.resolved || 'pending (bound when a script with that source loads, e.g. a lazy route)' };
  }

  async removeBreakpoint(id) {
    const i = this.breakpoints.findIndex((b) => b.id === id || id === 'all');
    if (id === 'all') { for (const b of this.breakpoints) for (const c of b.cdpIds) await this.send('Debugger.removeBreakpoint', { breakpointId: c.breakpointId }).catch(() => {}); this.breakpoints = []; return { removed: 'all' }; }
    if (i < 0) throw new Error('no breakpoint ' + id);
    const [bp] = this.breakpoints.splice(i, 1);
    for (const c of bp.cdpIds) await this.send('Debugger.removeBreakpoint', { breakpointId: c.breakpointId }).catch(() => {});
    return { removed: id };
  }

  listBreakpoints() { return this.breakpoints.map(({ id, file, line, condition, resolved }) => ({ id, file, line, condition, resolved })); }

  async step(kind) {
    await this.ensure();
    const m = { continue: 'Debugger.resume', over: 'Debugger.stepOver', into: 'Debugger.stepInto', out: 'Debugger.stepOut', pause: 'Debugger.pause' }[kind];
    if (!m) throw new Error('unknown step ' + kind);
    if (kind !== 'pause' && !this.paused) return { note: 'not paused' };
    await this.send(m, {});
    if (kind === 'continue') return { resumed: true };
    for (let i = 0; i < 30; i++) { await sleep(100); if (this.paused && this.paused.at > Date.now() - 3000) break; }
    return this.pauseState();
  }

  async setPauseOnExceptions(state) {
    this.pauseOnExceptions = state;
    if (this.running) await this.send('Debugger.setPauseOnExceptions', { state });
    return { pauseOnExceptions: state };
  }

  pauseState() {
    if (!this.paused) return { paused: false };
    const { frames, ...rest } = this.paused;
    return { paused: true, ...rest, frames: frames.map(({ callFrameId, ...f }) => f) };
  }

  status() {
    return {
      running: this.running, visible: this.visible, url: this.url, title: this.title,
      paused: this.paused ? { reason: this.paused.reason, at: this.paused.frames[0] } : null,
      breakpoints: this.breakpoints.length,
      errors: this.console.filter((c) => c.level === 'error' || c.level === 'exception').length,
    };
  }

  async close() {
    try { if (this.cdp) await this.cdp.send('Browser.close'); } catch { /* */ }
    this.cdp?.close(); this.cdp = null; this.session = null;
  }
}

function shortUrl(u) { try { const x = new URL(u); return x.pathname.replace(/^\//, '') || x.host; } catch { return String(u); } }
function shortPath(p) { const n = String(p).replace(/\\/g, '/').replace(/^webpack:\/\/\/?/, '').replace(/^\.\//, ''); const i = n.indexOf('src/'); return i >= 0 ? n.slice(i) : n; }

export function fmtRemote(v) {
  if (!v) return 'undefined';
  if (v.type === 'string') return JSON.stringify(v.value);
  if (v.type === 'undefined') return 'undefined';
  if ('value' in v && v.type !== 'object') return String(v.value);
  if (v.unserializableValue) return v.unserializableValue;
  if (v.subtype === 'null') return 'null';
  if (v.preview) {
    const p = v.preview;
    const inner = (p.properties || []).map((x) => (p.subtype === 'array' ? '' : x.name + ': ') + (x.type === 'string' ? JSON.stringify(x.value) : x.value)).join(', ');
    return (p.subtype === 'array' ? `[${inner}${p.overflow ? ', …' : ''}]` : `${v.className && v.className !== 'Object' ? v.className + ' ' : ''}{${inner}${p.overflow ? ', …' : ''}}`).slice(0, 300);
  }
  return (v.description || v.className || v.type || '').split('\n')[0].slice(0, 300);
}

export { normPath };
