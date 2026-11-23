import type { EngineInterface, Register } from 'claude-code'

// The Stackside pane: a live view of the debug browser you can drive from here,
// and the paused state of the browser's TypeScript and the .NET backend.
// All the work happens in the bridge (bridge/server.mjs, an MCP server this
// plugin starts); this module draws it and forwards presses.

const PANE = 'stackside'
const TITLE = 'Stackside'

// Raw colors with alpha read the same over light and dark themes; theme keys follow the theme.
const HL_LINE = '#EAB30833'   // the paused line
const HL_FRAME = '#3B82F626'  // the selected call-stack frame
const BP_DOT = '#E5484D'

type Who = 'dotnet' | 'js'
type Frame = { data: string; width: number; height: number; viewport: [number, number]; at: number }
type Loc = { fn?: string; file?: string | null; line?: number; column?: number; index?: number; generated?: boolean }
type WebStatus = { running: boolean; visible: boolean; url: string; title: string; paused: { reason: string; at: Loc } | null; breakpoints: number; errors: number }
type NetStatus = { state: string; project: string | null; pid: number | null; exitCode: number | null; paused: { reason: string; at: Loc; exception?: string } | null; breakpoints: number }
type Status = { web: WebStatus; dotnet: NetStatus; events: { seq: number; kind: string; reason: string; at: Loc; exception?: string }[]; seq: number }
type Local = { scope?: string; name: string; type?: string; value: string; ref?: number }
type Source = { path: string; line: number; startLine: number; lines: string[] }
type Pause = {
  paused: boolean; at?: number; reason?: string; text?: string; exception?: unknown; frame?: number
  frames?: Loc[]; hiddenFrames?: number; locals?: Local[]; localsError?: string; source?: Source | null
}
type Bp = { id: string; file: string; line: number; condition?: string; verified?: boolean | null; resolved?: string | null }

let server = ''
let status: Status | null = null
let frame: Frame | null = null
let tab: 'browser' | 'debugger' = 'browser'
let webPause: Pause | null = null
let netPause: Pause | null = null
let webBps: Bp[] = []
let netBps: Bp[] = []
let elements: string[] = []
let showElements = false
let busy = ''
let lastError = ''
let lastSeq = 0
let polling: { cancel: () => void } | null = null
let framing: { cancel: () => void } | null = null
let inFlightStatus = false
let inFlightFrame = false
let paneOpen = false
// per pause: expanded objects (key -> children), whether framework frames are shown, the last evaluation
let expanded = new Map<string, Local[]>()
let showAllFrames: Record<Who, boolean> = { dotnet: false, js: false }
let evalOut: Record<Who, { expr: string; value: string; isError?: boolean } | null> = { dotnet: null, js: null }
let pauseAt: Record<Who, number | undefined> = { dotnet: undefined, js: undefined }

async function bridge($: EngineInterface): Promise<string> {
  if (server) return server
  type Conn = { isConnected?: boolean; server?: string; reason?: string; message?: string }
  let r = (await $.mcp.connect('stackside')) as Conn
  // a session that loaded the mod before its rename still knows the bridge as "devdebug"
  if (!r.isConnected) {
    const old = (await $.mcp.connect('devdebug')) as Conn
    if (old.isConnected) r = old
  }
  if (!r.isConnected || !r.server) throw new Error('debug bridge not connected: ' + (r.message ?? r.reason ?? 'unknown'))
  server = r.server
  return server
}

async function call<T = unknown>($: EngineInterface, tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const s = await bridge($)
  const r = await $.mcp.call(s, tool, args)
  const block = r.content[0] as { type: string; text?: string } | undefined
  const text = block?.type === 'text' ? (block.text ?? '') : ''
  if (r.isError) throw new Error(text || tool + ' failed')
  try { return JSON.parse(text) as T } catch { return text as unknown as T }
}

function redraw($: EngineInterface) { void $.ui.invalidate('ui.render') }

async function act($: EngineInterface, label: string, fn: () => Promise<unknown>) {
  busy = label; lastError = ''; redraw($)
  try { await fn() } catch (err) { lastError = String((err as Error)?.message ?? err) }
  busy = ''
  await refresh($, true)
  pictureSoon($)
}

const base = (p?: string | null) => (p ? String(p).split(/[\\/]/).pop() ?? '' : '')
function where(l?: Loc | null): string {
  if (!l) return ''
  return `${l.file ? base(l.file) : '?'}:${l.line ?? '?'}`
}
const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
const samePlace = (a: string, b: string) => { const x = norm(a), y = norm(b); return x === y || x.endsWith('/' + y) || y.endsWith('/' + x) }

function statusLine(): string | undefined {
  if (!status) return undefined
  const parts: string[] = []
  const n = status.dotnet
  if (n.paused) parts.push(`⏸ .NET ${where(n.paused.at)}`)
  else if (n.state === 'running') parts.push('● .NET running')
  else if (n.state === 'building' || n.state === 'starting') parts.push('… .NET ' + n.state)
  const w = status.web
  if (w.paused) parts.push(`⏸ web ${where(w.paused.at)}`)
  else if (w.running && w.url) parts.push('● web ' + w.url.replace(/^https?:\/\//, '').slice(0, 40))
  return parts.length ? parts.join('  ') : undefined
}

/** A new pause (or none) clears what the pane opened inside the last one. */
function notePause(who: Who, p: Pause | null) {
  const at = p?.paused ? p.at : undefined
  if (at === pauseAt[who]) return
  pauseAt[who] = at
  for (const k of [...expanded.keys()]) if (k.startsWith(who + ':')) expanded.delete(k)
  showAllFrames[who] = false
  evalOut[who] = null
}

async function refresh($: EngineInterface, details = false) {
  if (inFlightStatus) return
  inFlightStatus = true
  try {
    const next = await call<Status>($, 'status', { since: lastSeq })
    const wasPaused = !!(status?.web.paused || status?.dotnet.paused)
    status = next
    for (const ev of next.events) {
      if (ev.seq <= lastSeq) continue
      const who = ev.kind.startsWith('dotnet') ? '.NET' : 'Browser'
      void $.ui.toast(`${who} paused (${ev.reason}${ev.exception ? ': ' + ev.exception : ''}) at ${where(ev.at)}`)
      tab = 'debugger'
    }
    lastSeq = next.seq
    const isPaused = !!(next.web.paused || next.dotnet.paused)
    if (details || isPaused || wasPaused !== isPaused || tab === 'debugger') {
      webPause = next.web.paused ? await call<Pause>($, 'js_state') : null
      netPause = next.dotnet.paused ? await call<Pause>($, 'dotnet_state') : null
      notePause('js', webPause); notePause('dotnet', netPause)
      webBps = next.web.breakpoints ? await call<Bp[]>($, 'js_breakpoints') : []
      netBps = next.dotnet.breakpoints ? await call<Bp[]>($, 'dotnet_breakpoints') : []
    }
    const line = statusLine()
    if (line !== lastStatusLine) { lastStatusLine = line; void $.ui.status(line) }
  } catch (err) {
    lastError = String((err as Error)?.message ?? err)
  } finally {
    inFlightStatus = false
    syncPolling($)
    // redraw only when something on screen changed: every redraw re-sends the page picture, which flickers
    const print = JSON.stringify([status?.web, status?.dotnet, webPause, netPause, webBps, netBps, lastError, tab])
    if (details || print !== lastPrint) { lastPrint = print; redraw($) }
  }
}
let lastPrint = ''
let lastStatusLine: string | undefined = '\u0000'

async function grabFrame($: EngineInterface) {
  if (inFlightFrame || !paneOpen || tab !== 'browser' || !status?.web.running || status.web.paused) return
  inFlightFrame = true
  try {
    const f = await call<Frame | null>($, 'pane_frame', { maxChars: 128000, width: 960 })
    if (f && f.data && f.data !== frame?.data) { frame = f; redraw($) }
  } catch { /* the next tick tries again */ } finally { inFlightFrame = false }
}

// The desktop app redraws the whole pane after every bridge call the pane makes, so the pane never polls
// while nothing can change on its own. The picture updates after each action (now and once more a moment
// later, for pages that settle); status is polled, slowly, only while a debug session could pause by itself.
function needsWatch(): boolean {
  if (!status) return false
  const n = status.dotnet, w = status.web
  return n.state === 'running' || n.state === 'starting' || n.state === 'building' || !!n.paused ||
    !!w.paused || (w.running && (w.breakpoints > 0 || w.visible))
}

function syncPolling($: EngineInterface) {
  const want = paneOpen && needsWatch()
  if (want && !polling) polling = $.clock.every(3000, () => { void refresh($) })
  if (!want && polling) { polling.cancel(); polling = null }
}

function pictureSoon($: EngineInterface) {
  void grabFrame($)
  framing?.cancel()
  framing = $.clock.after(1200, () => { framing = null; void grabFrame($) })
}

// once per load: the render hook calls this on every draw, and a refresh that redraws must not loop
let kicked = false
function startPolling($: EngineInterface) {
  if (kicked) return
  kicked = true
  void refresh($, true).then(() => pictureSoon($))
}

async function openPane($: EngineInterface) {
  const r = await $.ui.open({ id: PANE, title: TITLE })
  paneOpen = true
  kicked = true
  void refresh($, true).then(() => pictureSoon($))
  return r
}

// the same frame always yields the very same string, so an unchanged picture is never re-sent as new
let svgCache: { data: string; svg: string } | null = null
function svgFor(f: Frame): string {
  if (svgCache?.data === f.data) return svgCache.svg
  svgCache = { data: f.data, svg: svgOf(f) }
  return svgCache.svg
}
function svgOf(f: Frame): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${f.width}" height="${f.height}" viewBox="0 0 ${f.width} ${f.height}"><image width="${f.width}" height="${f.height}" href="data:image/jpeg;base64,${f.data}"/></svg>`
}

// ----- debugger actions -----
const stepTool = (who: Who) => (who === 'dotnet' ? 'dotnet_step' : 'js_step')

async function selectFrame($: EngineInterface, who: Who, index: number) {
  await act($, 'Switching frame', async () => {
    const p = await call<Pause>($, who === 'dotnet' ? 'dotnet_state' : 'js_state', { frame: index })
    if (who === 'dotnet') netPause = p; else webPause = p
    for (const k of [...expanded.keys()]) if (k.startsWith(who + ':')) expanded.delete(k)
    evalOut[who] = null
  })
}

async function toggleLocal($: EngineInterface, who: Who, key: string, ref: number) {
  if (expanded.has(key)) { expanded.delete(key); redraw($); return }
  try {
    const kids = await call<Local[]>($, who === 'dotnet' ? 'dotnet_variables' : 'js_variables', { ref })
    expanded.set(key, Array.isArray(kids) ? kids : [])
  } catch (err) { lastError = String((err as Error)?.message ?? err) }
  redraw($)
}

async function evaluate($: EngineInterface, who: Who, expr: string) {
  if (!expr.trim()) return
  try {
    const r = await call<{ value?: string; error?: string }>($, who === 'dotnet' ? 'dotnet_eval' : 'web_eval', { expression: expr })
    evalOut[who] = r.error != null ? { expr, value: r.error, isError: true } : { expr, value: String(r.value ?? '') }
  } catch (err) { evalOut[who] = { expr, value: String((err as Error)?.message ?? err), isError: true } }
  redraw($)
}

function bpAt(who: Who, path: string, line: number): Bp | undefined {
  return (who === 'dotnet' ? netBps : webBps).find(b => b.line === line && samePlace(b.file, path))
}

async function toggleBreakpoint($: EngineInterface, who: Who, path: string, line: number) {
  const have = bpAt(who, path, line)
  await act($, have ? 'Removing breakpoint' : 'Setting breakpoint', () => have
    ? call($, who === 'dotnet' ? 'dotnet_remove_breakpoint' : 'js_remove_breakpoint', { id: have.id })
    : call($, who === 'dotnet' ? 'dotnet_breakpoint' : 'js_breakpoint', { file: path, line }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'stackside', description: 'Open the Stackside pane (browser view + .NET / TypeScript debugger)' })
    await $.command.register({ name: 'debug-web', description: 'Open a URL in the debug browser, e.g. /debug-web localhost:4200' })
    await $.command.register({ name: 'debug-api', description: 'Build and launch a .NET project under the debugger, e.g. /debug-api C:\\src\\MyApp' })
    await $.command.register({ name: 'debug-stop', description: 'Stop the .NET debug session' })
    return started
  })

  on('command.run', { command: 'stackside' }, async $ => {
    await openPane($)
    return { text: 'Stackside pane opened.' }
  })

  on('command.run', { command: 'debug-web' }, async ($, e) => {
    await openPane($)
    const url = e.args.trim() || 'http://localhost:4200'
    tab = 'browser'
    await act($, 'Opening ' + url, () => call($, 'web_open', { url }))
    return { text: lastError ? 'Could not open ' + url + ': ' + lastError : 'Opened ' + url + ' in the debug browser.' }
  })

  on('command.run', { command: 'debug-api' }, async ($, e) => {
    const project = e.args.trim()
    if (!project) return { text: 'Usage: /debug-api <path to .csproj or its folder>' }
    await openPane($)
    tab = 'debugger'
    await act($, 'Building and launching', () => call($, 'dotnet_launch', { project }))
    return { text: lastError ? 'Launch failed: ' + lastError : 'Launched ' + project + ' under the debugger.' }
  })

  on('command.run', { command: 'debug-stop' }, async $ => {
    await act($, 'Stopping', () => call($, 'dotnet_stop'))
    return { text: 'Stopped the .NET debug session.' }
  })

  // Seeing Claude's own bridge calls keeps the pane current right away.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (/stackside|devdebug/.test(String(e.tool)) && paneOpen) { void refresh($, true).then(() => pictureSoon($)) }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const el = $.ui.resolve(e) as unknown as Record<string, ((p: unknown) => unknown) | undefined>
    const Svg = el.Svg as unknown as ((p: { source: string; alt: string; width?: number }) => JSX.Element) | undefined
    paneOpen = true
    startPolling($)

    const w = status?.web
    const n = status?.dotnet
    if (e.props.placement === 'widget') {
      return <Text>{statusLine() ?? 'Stackside: idle'}</Text>
    }

    const anyPaused = !!(w?.paused || n?.paused)
    const header = (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Button key="tab-browser" variant={tab === 'browser' ? 'primary' : 'secondary'} onPress={() => { tab = 'browser'; redraw($); pictureSoon($) }}>◫ Browser</Button>
        <Button key="tab-debugger" variant={tab === 'debugger' ? 'primary' : 'secondary'} onPress={() => { tab = 'debugger'; void refresh($, true) }}>
          {anyPaused ? '⏸ Debugger ●' : '⏸ Debugger'}
        </Button>
        <Box flexGrow={1} />
        <Text dimColor size="footnote" wrap="truncate-end">{busy ? busy + '…' : (statusLine() ?? 'Idle')}</Text>
      </Box>
    )
    const error = lastError ? (
      <Box borderStyle="round" borderColor="error" paddingX={1}>
        <Text color="error">{lastError.slice(0, 600)}</Text>
      </Box>
    ) : null

    // ===== browser tab =====
    if (tab === 'browser') {
      const visibleInChrome = !!w?.visible
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Box flexDirection="row" gap={1} alignItems="center">
            <Button key="back" onPress={() => act($, 'Back', () => call($, 'web_nav', { action: 'back' }))}>◀</Button>
            <Button key="fwd" onPress={() => act($, 'Forward', () => call($, 'web_nav', { action: 'forward' }))}>▶</Button>
            <Button key="reload" onPress={() => act($, 'Reloading', () => call($, 'web_nav', { action: 'reload' }))}>⟳</Button>
            <Box flexGrow={1}>
              <Input key="url" value={w?.url && w.url !== 'about:blank' ? w.url : ''} placeholder="http://localhost:4200" submitLabel="Go"
                onSubmit={value => { const url = value.trim() || 'http://localhost:4200'; void act($, 'Opening', () => call($, 'web_open', { url })) }} />
            </Box>
            <Button key="chrome" variant="primary" onPress={() => act($, visibleInChrome ? 'Bringing back' : 'Opening in Chrome', () => call($, 'web_show', { visible: !visibleInChrome }))}>
              {visibleInChrome ? '⇤ Bring back' : '↗ Open in Chrome'}
            </Button>
          </Box>
          {error}
          {visibleInChrome && <Text dimColor size="footnote">Also showing in a Chrome window: same tab, same sign-in, breakpoints still on. Use either.</Text>}
          {!w?.running && (
            <Box borderStyle="round" borderDimColor paddingX={2} paddingY={1} flexDirection="column" gap={1}>
              <Text weight="medium">No page open yet</Text>
              <Text dimColor>Enter your app's address above, run /debug-web localhost:4200, or ask Claude to open it.</Text>
            </Box>
          )}
          {w?.paused && (
            <Box borderStyle="round" borderColor="warning" paddingX={1} flexDirection="row" gap={1} alignItems="center">
              <Text color="warning" weight="medium">⏸ Paused</Text>
              <Text>{`at ${where(w.paused.at)}`}</Text>
              <Box flexGrow={1} />
              <Button key="goto-debugger" onPress={() => { tab = 'debugger'; void refresh($, true) }}>Open debugger</Button>
            </Box>
          )}
          {/* no click layer over the picture: the overlaid client surface made the picture flicker */}
          {w?.running && frame && Svg && (
            <Box borderStyle="round" borderDimColor overflow="hidden">
              <Svg key="page" source={svgFor(frame)} alt={`${w.title || 'page'}: ${w.url}`} />
            </Box>
          )}
          {w?.running && !Svg && <Text dimColor>{`${w.title} (${w.url}): this surface can't draw the page; use Open in Chrome.`}</Text>}
          {w?.running && (
            <Box flexDirection="column" gap={1}>
              <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
                <Box flexGrow={1} minWidth={220}>
                  <Input key="clicktext" label="Click" placeholder="Save" submitLabel="Click"
                    onSubmit={value => act($, 'Clicking', () => call($, 'web_click', { text: value.trim() }))} />
                </Box>
                <Box flexGrow={1} minWidth={220}>
                  <Input key="type" label="Type" placeholder="text for the focused field" submitLabel="Type"
                    onSubmit={value => act($, 'Typing', () => call($, 'web_type', { text: value }))} />
                </Box>
              </Box>
              <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
                <Button key="k-enter" variant="secondary" onPress={() => act($, '', () => call($, 'web_key', { key: 'Enter' }))}>⏎ Enter</Button>
                <Button key="k-tab" variant="secondary" onPress={() => act($, '', () => call($, 'web_key', { key: 'Tab' }))}>⇥ Tab</Button>
                <Button key="k-esc" variant="secondary" onPress={() => act($, '', () => call($, 'web_key', { key: 'Escape' }))}>Esc</Button>
                <Button key="k-bs" variant="secondary" onPress={() => act($, '', () => call($, 'web_key', { key: 'Backspace' }))}>⌫</Button>
                <Button key="up" variant="secondary" onPress={() => act($, '', () => call($, 'web_scroll', { dy: -500 }))}>↑ Scroll</Button>
                <Button key="down" variant="secondary" onPress={() => act($, '', () => call($, 'web_scroll', { dy: 500 }))}>↓ Scroll</Button>
                <Box flexGrow={1} />
                <Button key="snap" variant="secondary" onPress={() => pictureSoon($)}>↻ Picture</Button>
                <Button key="elements" variant="secondary" onPress={async () => {
                  showElements = !showElements
                  if (showElements) { try { const s = await call<{ items: string[] }>($, 'web_snapshot'); elements = s.items } catch (err) { lastError = String(err) } }
                  redraw($)
                }}>{showElements ? '☰ Hide elements' : '☰ Elements'}</Button>
              </Box>
            </Box>
          )}
          {showElements && (
            <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
              <Text dimColor size="footnote">Click an element</Text>
              {elements.slice(0, 40).map(item => {
                const ref = Number(item.split(':')[0])
                return (
                  <Button key={'el-' + ref} plain onPress={() => act($, 'Clicking', async () => { await call($, 'web_click', { ref }); const s = await call<{ items: string[] }>($, 'web_snapshot'); elements = s.items })}>{item.slice(0, 90)}</Button>
                )
              })}
            </Box>
          )}
        </Box>
      )
    }

    // ===== debugger tab =====
    // the step keys go to one session: .NET when it is paused, else the page
    const keysFor: Who | null = netPause?.paused ? 'dotnet' : webPause?.paused ? 'js' : null

    const toolbar = (who: Who) => {
      const k = keysFor === who
      const step = (action: string, label: string) => act($, label, () => call($, stepTool(who), { action }))
      return (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key={who + '-cont'} variant="primary" hotkey={k ? 'c' : undefined} onPress={() => step('continue', 'Continuing')}>▶ Continue</Button>
          <Button key={who + '-over'} variant="secondary" hotkey={k ? 'o' : undefined} onPress={() => step('over', 'Stepping')}>↷ Over</Button>
          <Button key={who + '-into'} variant="secondary" hotkey={k ? 'i' : undefined} onPress={() => step('into', 'Stepping')}>↓ Into</Button>
          <Button key={who + '-out'} variant="secondary" hotkey={k ? 'u' : undefined} onPress={() => step('out', 'Stepping')}>↑ Out</Button>
        </Box>
      )
    }

    const sourceView = (who: Who, src: Source) => {
      const width = String(src.startLine + src.lines.length - 1).length
      return (
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingY={0}>
          <Box paddingX={1}><Text dimColor size="footnote" wrap="truncate-start">{src.path}</Text></Box>
          {src.lines.map((text, i) => {
            const ln = src.startLine + i
            const isHere = ln === src.line
            const bp = bpAt(who, src.path, ln)
            return (
              <Box key={`${who}-src-${ln}`} flexDirection="row" backgroundColor={isHere ? HL_LINE : undefined}>
                <Button key={`${who}-gut-${ln}`} plain dimColor={!bp && !isHere} onPress={() => toggleBreakpoint($, who, src.path, ln)}>
                  {(bp ? '●' : ' ') + ' ' + String(ln).padStart(width, ' ')}
                </Button>
                <Text mono wrap="truncate-end">{(isHere ? '▸ ' : '  ') + (text || ' ')}</Text>
              </Box>
            )
          })}
        </Box>
      )
    }

    const callStack = (who: Who, p: Pause) => {
      // a frame is the user's when it maps to their own source, not a bundle or a library
      const lib = (f: Loc) => !f.file || !!f.generated || /(^|[\\/])node_modules[\\/]|^\.\.[\\/]/.test(f.file)
      const frames = (p.frames ?? []).map((f, i) => ({ ...f, index: f.index ?? i }))
      const sel = p.frame ?? 0
      // framework frames collapse after the first few, unless asked for, or selected
      const rows: (typeof frames[number] | { more: number })[] = []
      let hiddenRun = 0
      frames.forEach((f, i) => {
        const keep = showAllFrames[who] || !lib(f) || i < 3 || f.index === sel
        if (keep) { if (hiddenRun) { rows.push({ more: hiddenRun }); hiddenRun = 0 } rows.push(f) } else hiddenRun++
      })
      if (hiddenRun) rows.push({ more: hiddenRun })
      return (
        <Box flexDirection="column" flexGrow={1} minWidth={240} borderStyle="round" borderDimColor paddingX={1}>
          <Text dimColor size="footnote">Call stack</Text>
          {rows.map((r, i) => 'more' in r
            ? <Button key={`${who}-more-${i}`} plain dimColor onPress={() => { showAllFrames[who] = true; redraw($) }}>{`+ ${r.more} framework frames`}</Button>
            : (
              <Box key={`${who}-fr-${r.index}`} backgroundColor={r.index === sel ? HL_FRAME : undefined}>
                <Button key={`${who}-frb-${r.index}`} plain dimColor={lib(r)} onPress={() => selectFrame($, who, r.index)}>
                  {!lib(r) ? `${r.fn ?? '?'}  ${where(r)}` : (r.fn ?? '?')}
                </Button>
              </Box>
            ))}
          {!!p.hiddenFrames && <Text dimColor size="footnote">{`${p.hiddenFrames} more framework frames not loaded`}</Text>}
          {showAllFrames[who] && <Button key={`${who}-less`} plain dimColor onPress={() => { showAllFrames[who] = false; redraw($) }}>Hide framework frames</Button>}
        </Box>
      )
    }

    const localRows = (who: Who, list: Local[], path: string, depth: number): JSX.Element[] => list.slice(0, 60).flatMap(v => {
      const key = `${who}:${path}/${v.name}`
      const open = expanded.get(key)
      const pad = depth * 2
      const label = `${v.name}${v.type ? ': ' + v.type : ''}`
      const row = v.ref && depth < 4
        ? (
          <Box key={key} paddingLeft={pad}>
            <Button key={key + '-b'} plain onPress={() => toggleLocal($, who, key, v.ref!)}>{`${open ? '▾' : '▸'} ${label} = ${v.value}`.slice(0, 200)}</Button>
          </Box>
        )
        : <Box key={key} paddingLeft={pad + 2}><Text mono wrap="truncate-end">{`${label} = ${v.value}`.slice(0, 200)}</Text></Box>
      return open ? [row, ...localRows(who, open, path + '/' + v.name, depth + 1)] : [row]
    })

    const localsBox = (who: Who, p: Pause) => {
      const out = evalOut[who]
      return (
        <Box flexDirection="column" flexGrow={1} minWidth={240} borderStyle="round" borderDimColor paddingX={1}>
          <Text dimColor size="footnote">Locals</Text>
          {(p.locals ?? []).length === 0 && <Text dimColor>{p.localsError ? 'Locals unavailable here' : 'No locals in this frame'}</Text>}
          {localRows(who, p.locals ?? [], 'f' + (p.frame ?? 0), 0)}
          <Input key={`${who}-eval`} placeholder={who === 'dotnet' ? 'Evaluate C#, e.g. order.Total' : 'Evaluate JS, e.g. this.items.length'} submitLabel="Eval"
            onSubmit={value => evaluate($, who, value)} />
          {out && <Text mono color={out.isError ? 'error' : undefined}>{`${out.expr} = ${out.value}`.slice(0, 1200)}</Text>}
        </Box>
      )
    }

    const pausedCard = (who: Who, p: Pause) => {
      const frames = p.frames ?? []
      const at = frames.find(f => (f.index ?? -1) === p.frame) ?? frames[p.frame ?? 0] ?? frames.find(f => f.file)
      const ex = p.exception ? (typeof p.exception === 'string' ? p.exception : JSON.stringify(p.exception, null, 1)) : ''
      return (
        <Box key={who + '-paused'} flexDirection="column" gap={1}>
          <Box borderStyle="round" borderColor="warning" paddingX={1} flexDirection="column" gap={1}>
            <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
              <Text color="warning" weight="semibold">⏸ Paused</Text>
              <Text dimColor>{`${p.reason ?? 'paused'} · ${who === 'dotnet' ? '.NET' : 'Browser'}`}</Text>
              <Box flexGrow={1} />
              <Text mono wrap="truncate-start">{`${at?.fn ?? ''}  ${where(at)}`}</Text>
            </Box>
            {ex && <Text color="error">{ex.slice(0, 800)}</Text>}
            {toolbar(who)}
            {keysFor === who && <Text dimColor size="caption">Keys while this pane has focus: c continue · o over · i into · u out</Text>}
          </Box>
          {p.source && sourceView(who, p.source)}
          <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="flex-start">
            {callStack(who, p)}
            {localsBox(who, p)}
          </Box>
        </Box>
      )
    }

    const sessionRow = (who: Who) => {
      if (who === 'dotnet') {
        const state = n?.state ?? 'idle'
        const live = state === 'running' || state === 'starting' || state === 'building'
        return (
          <Box key="dotnet-row" flexDirection="row" gap={1} alignItems="center" borderStyle="round" borderDimColor paddingX={1}>
            <Text color={live ? 'success' : undefined} dimColor={!live}>●</Text>
            <Text weight="medium">.NET</Text>
            <Text dimColor wrap="truncate-end">{state + (n?.project ? ' · ' + base(n.project) : '') + (n?.exitCode != null ? ' · exit ' + n.exitCode : '')}</Text>
            <Box flexGrow={1} />
            {state === 'running' && <Button key="dotnet-pause" variant="secondary" onPress={() => act($, 'Pausing', () => call($, 'dotnet_step', { action: 'pause' }))}>⏸ Pause</Button>}
            {live && <Button key="dotnet-stop" variant="secondary" onPress={() => act($, 'Stopping', () => call($, 'dotnet_stop'))}>■ Stop</Button>}
          </Box>
        )
      }
      return (
        <Box key="js-row" flexDirection="row" gap={1} alignItems="center" borderStyle="round" borderDimColor paddingX={1}>
          <Text color={w?.running ? 'success' : undefined} dimColor={!w?.running}>●</Text>
          <Text weight="medium">Browser</Text>
          <Text dimColor wrap="truncate-end">{w?.running ? (w.url || 'running').replace(/^https?:\/\//, '') : 'not open'}</Text>
          <Box flexGrow={1} />
          {w?.running && <Button key="js-pause" variant="secondary" onPress={() => act($, 'Pausing', () => call($, 'js_step', { action: 'pause' }))}>⏸ Pause page</Button>}
        </Box>
      )
    }

    const allBps = [...netBps.map(b => ({ b, who: 'dotnet' as Who })), ...webBps.map(b => ({ b, who: 'js' as Who }))]
    const bpCard = allBps.length === 0 ? null : (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        <Text dimColor size="footnote">Breakpoints</Text>
        {allBps.map(({ b, who }) => {
          const unbound = b.verified === false || (who === 'js' && !b.resolved)
          return (
            <Box key={who + '-bp-' + b.id} flexDirection="row" gap={1} alignItems="center">
              <Text color={unbound ? undefined : BP_DOT} dimColor={unbound}>●</Text>
              <Text mono dimColor={unbound} wrap="truncate-start">{`${base(b.file)}:${b.line}${b.condition ? ' if ' + b.condition : ''}`}</Text>
              {unbound && <Text dimColor size="footnote">not bound yet</Text>}
              <Box flexGrow={1} />
              <Button key={who + '-rm-' + b.id} plain dimColor onPress={() => act($, 'Removing', () => call($, who === 'dotnet' ? 'dotnet_remove_breakpoint' : 'js_remove_breakpoint', { id: b.id }))}>✕</Button>
            </Box>
          )
        })}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {error}
        {netPause?.paused ? pausedCard('dotnet', netPause) : sessionRow('dotnet')}
        {webPause?.paused ? pausedCard('js', webPause) : sessionRow('js')}
        {bpCard}
        <Text dimColor size="footnote">Click a line number to set or remove a breakpoint, or ask Claude, e.g. "break in OrderService.cs line 40".</Text>
      </Box>
    )
  })
}
