#!/usr/bin/env node
// stackside bridge: an MCP server (stdio) that holds a Chrome session and a
// .NET debug session so Claude Code can drive and debug both.
import { createInterface } from 'node:readline';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Web } from './web.mjs';
import { DotNet, findNetcoredbg, installNetcoredbg } from './dotnet.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.CLAUDE_PLUGIN_DATA || join(process.env.LOCALAPPDATA || process.env.HOME || here, 'stackside');
mkdirSync(dataDir, { recursive: true });
const log = (m) => process.stderr.write('[stackside] ' + m + '\n');

const web = new Web({ dataDir, log });
const pluginRoot = join(here, '..');
const net = new DotNet({ findExe: () => findNetcoredbg({ pluginRoot, dataDir }), log });
const events = []; let eventSeq = 0;
const pushEvent = (e) => { events.push({ seq: ++eventSeq, t: Date.now(), ...e }); if (events.length > 100) events.shift(); };
web.onPause = (p) => pushEvent({ kind: 'web.paused', reason: p.reason, at: p.frames[0] });
net.onPause = (p) => pushEvent({ kind: 'dotnet.paused', reason: p.reason, at: p.frames.find((f) => f.file) || p.frames[0], exception: p.exception?.type });

const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (d) => ({ type: 'string', description: d });
const num = (d) => ({ type: 'number', description: d });
const bool = (d) => ({ type: 'boolean', description: d });

const tools = {
  // ----- browser -----
  web_open: { d: 'Open a URL in the debug browser (a dedicated Chrome the bridge controls; hidden off-screen unless shown). Starts Chrome if needed. Use for the Angular app, e.g. http://localhost:4200.', s: S({ url: str('URL to open') }, ['url']), f: (a) => web.open(a.url) },
  web_nav: { d: 'Go back, forward, or reload the debug browser.', s: S({ action: { type: 'string', enum: ['back', 'forward', 'reload'] } }, ['action']), f: (a) => web.nav(a.action) },
  web_snapshot: { d: 'Read the current page: URL, title, visible text, and a numbered list of clickable/typeable elements. Use the numbers as `ref` in web_click / web_type. Re-run after the page changes.', s: S({}), f: () => web.snapshot() },
  web_screenshot: { d: 'Take a PNG screenshot of the debug browser page to look at.', s: S({}), f: async () => ({ __image: await web.screenshot() }) },
  web_click: { d: 'Click in the page: by `ref` from web_snapshot (preferred), by CSS `selector`, by visible `text`, or at viewport pixel `x`,`y`.', s: S({ ref: num('element number from web_snapshot'), selector: str('CSS selector'), text: str('visible text of the element'), x: num('viewport x (CSS px)'), y: num('viewport y (CSS px)'), fx: num('fraction of viewport width 0..1'), fy: num('fraction of viewport height 0..1') }), f: (a) => web.click(a) },
  web_type: { d: 'Type text into the page. With `ref`/`selector` it clicks that field first; otherwise types into the focused element. `clear` empties the field first, `submit` presses Enter after.', s: S({ text: str('text to type'), ref: num('element number from web_snapshot'), selector: str('CSS selector'), clear: bool('clear the field first'), submit: bool('press Enter afterwards') }), f: (a) => web.type(a) },
  web_key: { d: 'Press a key in the page: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, PageUp/PageDown, Home, End, Space.', s: S({ key: str('key name') }, ['key']), f: (a) => web.key(a.key) },
  web_scroll: { d: 'Scroll the page by `dy` pixels (positive = down).', s: S({ dy: num('pixels, default 500') }), f: (a) => web.scroll(a.dy ?? 500) },
  web_eval: { d: 'Evaluate JavaScript in the page. When the page is paused at a breakpoint, evaluates in that frame (so locals are in scope). Objects come back as JSON.', s: S({ expression: str('JS expression'), frame: num('call-stack frame index when paused, default 0') }, ['expression']), f: (a) => web.evaluate(a.expression, a.frame) },
  web_console: { d: 'Recent console messages and uncaught exceptions from the page.', s: S({ since: num('only after this epoch ms'), clear: bool('clear after reading'), limit: num('max rows') }), f: (a) => web.consoleLog(a) },
  web_network: { d: 'Recent page requests (XHR/fetch/documents, plus anything failed or >= 400): method, url, status, ms. Use `filter` (substring) e.g. "/api/".', s: S({ filter: str('URL substring'), onlyErrors: bool('only failed or >= 400'), limit: num('max rows') }), f: (a) => web.networkLog(a) },
  web_response: { d: 'Body of a response from web_network, by its id.', s: S({ id: str('request id from web_network') }, ['id']), f: (a) => web.responseBody(a.id) },
  web_show: { d: 'Show the debug browser as a normal Chrome window on screen ("continue in Chrome"): same tab, same sign-in, breakpoints still active. visible=false puts it back off-screen so it is only seen in the Claude pane.', s: S({ visible: bool('true = on screen, false = back to the pane only') }, ['visible']), f: (a) => web.show(a.visible) },
  // ----- browser JS debugging -----
  js_breakpoint: { d: 'Set a breakpoint in the Angular app\'s TypeScript, e.g. file "src/app/orders/order-list.component.ts", line 42 (1-based). Mapped through source maps; binds when the chunk loads.', s: S({ file: str('source path or unique suffix'), line: num('1-based line'), condition: str('optional JS condition') }, ['file', 'line']), f: (a) => web.setBreakpoint(a) },
  js_breakpoints: { d: 'List browser breakpoints.', s: S({}), f: () => web.listBreakpoints() },
  js_remove_breakpoint: { d: 'Remove a browser breakpoint by id, or "all".', s: S({ id: str('breakpoint id or "all"') }, ['id']), f: (a) => web.removeBreakpoint(a.id) },
  js_exceptions: { d: 'Pause the page on exceptions: none, uncaught, all.', s: S({ mode: { type: 'string', enum: ['none', 'uncaught', 'all'] } }, ['mode']), f: (a) => web.setPauseOnExceptions(a.mode) },
  js_step: { d: 'Control the paused page: continue, over, into, out, or pause.', s: S({ action: { type: 'string', enum: ['continue', 'over', 'into', 'out', 'pause'] } }, ['action']), f: (a) => web.step(a.action) },
  js_state: { d: 'Where the page is paused: reason, call stack (TypeScript locations), locals of the top frame.', s: S({}), f: () => web.pauseState() },
  // ----- .NET -----
  dotnet_setup: { d: 'One-time setup: download the .NET debugger, Samsung netcoredbg (MIT, about 3.5 MB, from github.com/Samsung/netcoredbg releases), into this plugin\'s data folder. Ask the user before running it. Not needed when netcoredbg is already on PATH or STACKSIDE_NETCOREDBG points at one.', s: S({ version: str('release tag, default the latest'), force: bool('download again even if one is found') }), f: async (a) => { const have = findNetcoredbg({ pluginRoot, dataDir }); if (have && !a.force) return { alreadyInstalled: have }; return installNetcoredbg({ dataDir, version: a.version }); } },
  dotnet_launch: { d: 'Build and start an ASP.NET Core / .NET project under the debugger (netcoredbg). `project` is a .csproj or its folder (a solution folder picks its single web project). Uses the launchSettings.json profile (env vars + applicationUrl).', s: S({ project: str('path to .csproj or folder'), profile: str('launchSettings profile name'), args: { type: 'array', items: { type: 'string' } }, env: { type: 'object', additionalProperties: { type: 'string' } }, stopAtEntry: bool('pause at Main'), build: bool('build first (default true)') }, ['project']), f: (a) => net.launch(a) },
  dotnet_attach: { d: 'Attach the .NET debugger to a running process by id or by name/command-line substring (e.g. "MyApp.Api"). Pass `project` so relative breakpoint paths resolve.', s: S({ processId: num('process id'), processName: str('name or command-line substring'), project: str('project folder for path resolution') }), f: (a) => net.attach(a) },
  dotnet_stop: { d: 'End the .NET debug session (stops a launched process; detaches from an attached one).', s: S({}), f: () => net.stop() },
  dotnet_breakpoint: { d: 'Set a C# breakpoint: `file` absolute, relative to the solution, or a unique file name (e.g. "OrderService.cs"); `line` 1-based. Works before launch too.', s: S({ file: str('C# file'), line: num('1-based line'), condition: str('optional C# condition, e.g. order.Id == 5'), project: str('project folder, if no session yet') }, ['file', 'line']), f: (a) => net.setBreakpoint(a) },
  dotnet_breakpoints: { d: 'List C# breakpoints and whether they are verified (bound to loaded code).', s: S({}), f: () => net.listBreakpoints() },
  dotnet_remove_breakpoint: { d: 'Remove a C# breakpoint by id, or "all".', s: S({ id: str('breakpoint id or "all"') }, ['id']), f: (a) => net.removeBreakpoint(a.id) },
  dotnet_exceptions: { d: 'Break on .NET exceptions: none, user-unhandled (default), all (first-chance).', s: S({ mode: { type: 'string', enum: ['none', 'user-unhandled', 'all'] } }, ['mode']), f: (a) => net.setExceptions(a.mode) },
  dotnet_step: { d: 'Control the paused .NET process: continue, over, into, out, or pause (break all).', s: S({ action: { type: 'string', enum: ['continue', 'over', 'into', 'out', 'pause'] } }, ['action']), f: (a) => net.step(a.action) },
  dotnet_state: { d: 'Where .NET is paused: reason, exception, call stack, locals of the top user frame (with `ref` ids to expand via dotnet_variables).', s: S({}), f: () => net.pauseState() },
  dotnet_variables: { d: 'Expand a variable (its `ref` from dotnet_state / dotnet_eval).', s: S({ ref: num('variablesReference') }, ['ref']), f: (a) => net.variables(a.ref) },
  dotnet_eval: { d: 'Evaluate a C# expression in a paused frame (default the top frame).', s: S({ expression: str('C# expression'), frame: num('frame index') }, ['expression']), f: (a) => net.evaluate(a.expression, a.frame) },
  dotnet_output: { d: 'Recent console output of the debugged .NET process (stdout/stderr/logs).', s: S({ since: num('only after this epoch ms'), filter: str('substring'), limit: num('max lines') }), f: (a) => net.outputLog(a) },
  // ----- both -----
  status: { d: 'Overview of both sessions: browser (url, visible, paused) and .NET (state, paused location), plus recent pause events.', s: S({ since: num('events after this seq') }), f: (a) => ({ web: web.status(), dotnet: net.status(), events: events.filter((e) => e.seq > (a.since || 0)), seq: eventSeq }) },
  pane_frame: { d: 'Internal (used by the Stackside pane): a small JPEG of the page as base64.', s: S({ maxChars: num('max base64 chars'), width: num('target width px') }), f: async (a) => (web.running ? web.frame(a) : null) },
};

// ---------- MCP stdio ----------
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stackside', version: '0.1.1' }, instructions: 'Debug the user\'s web frontend (Chrome, TypeScript breakpoints) and .NET backend (netcoredbg) from Claude Code. Typical flow: dotnet_breakpoint + dotnet_launch for the API; web_open the Angular dev server; web_snapshot then web_click/web_type to drive it; when something pauses, read dotnet_state / js_state, inspect, then *_step continue. web_show visible=true hands the same browser window to the user in Chrome.' } });
    }
    if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.d, inputSchema: t.s })) } });
    if (method === 'tools/call') {
      const t = tools[params.name];
      if (!t) return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'unknown tool ' + params.name }] } });
      try {
        const out = await t.f(params.arguments || {});
        if (out && out.__image) return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'image', data: out.__image, mimeType: 'image/png' }] } });
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out ?? null, null, 1) }] } });
      } catch (e) {
        return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: String(e?.message || e) }] } });
      }
    }
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
  } catch (e) {
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message || e) } });
  }
});

const shutdown = async () => { try { await net.stop(); } catch { /* */ } process.exit(0); };
rl.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
