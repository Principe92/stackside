import type { EngineInterface, Register } from 'claude-code'

// The Debug pane: a live view of the debug browser you can drive from here,
// and the paused state of the browser's TypeScript and the .NET backend.
// All the work happens in the bridge (bridge/server.mjs, an MCP server this
// plugin starts); this module draws it and forwards presses.

const PANE = 'stackside'
const TITLE = 'Stackside'

type Frame = { data: string; width: number; height: number; viewport: [number, number]; at: number }
type Loc = { fn?: string; file?: string | null; line?: number; column?: number }
type WebStatus = { running: boolean; visible: boolean; url: string; title: string; paused: { reason: string; at: Loc } | null; breakpoints: number; errors: number }
type NetStatus = { state: string; project: string | null; pid: number | null; exitCode: number | null; paused: { reason: string; at: Loc; exception?: string } | null; breakpoints: number }
type Status = { web: WebStatus; dotnet: NetStatus; events: { seq: number; kind: string; reason: string; at: Loc; exception?: string }[]; seq: number }
type Pause = { paused: boolean; reason?: string; text?: string; exception?: unknown; frames?: Loc[]; locals?: { scope?: string; name: string; type?: string; value: string }[] }
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

async function bridge($: EngineInterface): Promise<string> {
  if (server) return server
  const r = (await $.mcp.connect('stackside')) as { isConnected?: boolean; server?: string; reason?: string; message?: string }
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
  void grabFrame($)
}

function where(l?: Loc | null): string {
  if (!l) return ''
  const file = l.file ? String(l.file).split(/[\\/]/).pop() : '?'
  return `${file}:${l.line ?? '?'}`
}

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
      webBps = next.web.breakpoints ? await call<Bp[]>($, 'js_breakpoints') : []
      netBps = next.dotnet.breakpoints ? await call<Bp[]>($, 'dotnet_breakpoints') : []
    }
    void $.ui.status(statusLine())
  } catch (err) {
    lastError = String((err as Error)?.message ?? err)
  } finally {
    inFlightStatus = false
    redraw($)
  }
}

async function grabFrame($: EngineInterface) {
  if (inFlightFrame || !paneOpen || tab !== 'browser' || !status?.web.running || status.web.paused) return
  inFlightFrame = true
  try {
    const f = await call<Frame | null>($, 'pane_frame', { maxChars: 128000, width: 960 })
    if (f && f.data) { frame = f; redraw($) }
  } catch { /* the next tick tries again */ } finally { inFlightFrame = false }
}

function startPolling($: EngineInterface) {
  if (!polling) polling = $.clock.every(1200, () => { void refresh($) })
  if (!framing) framing = $.clock.every(700, () => { void grabFrame($) })
}

async function openPane($: EngineInterface) {
  const r = await $.ui.open({ id: PANE, title: TITLE })
  paneOpen = true
  startPolling($)
  void refresh($, true)
  return r
}

function svgFor(f: Frame): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${f.width}" height="${f.height}" viewBox="0 0 ${f.width} ${f.height}"><image width="${f.width}" height="${f.height}" href="data:image/jpeg;base64,${f.data}"/></svg>`
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

  // Clicks and keys from the picture of the page.
  on('ui.message', async ($, e, next) => {
    const data = (e as unknown as { data?: { kind?: string; fx?: number; fy?: number; key?: string } }).data
    if (!data?.kind) return next(e)
    if (data.kind === 'click' && typeof data.fx === 'number' && typeof data.fy === 'number') {
      const fx = data.fx, fy = data.fy
      void act($, 'Clicking', () => call($, 'web_click', { fx, fy }))
    } else if (data.kind === 'key' && data.key) {
      const map: Record<string, string> = { return: 'Enter', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End', space: 'Space', ' ': 'Space' }
      const k = map[data.key] ?? data.key
      void act($, '', () => (k.length === 1 ? call($, 'web_type', { text: k }) : call($, 'web_key', { key: k })))
    }
    return next(e)
  })

  // Seeing Claude's own bridge calls keeps the pane current right away.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (String(e.tool).includes('stackside') && paneOpen) { void refresh($, true); void grabFrame($) }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const el = $.ui.resolve(e) as unknown as Record<string, ((p: unknown) => unknown) | undefined>
    const Svg = el.Svg as unknown as ((p: { source: string; alt: string; width?: number }) => JSX.Element) | undefined
    const Client = el.Client as unknown as ((p: { key: string; module: string; props?: unknown; width?: number | string; height?: number | string }) => JSX.Element) | undefined
    const Code = el.Code as unknown as ((p: { source: string; language?: string }) => JSX.Element) | undefined
    paneOpen = true
    startPolling($)

    const w = status?.web
    const n = status?.dotnet
    const narrow = e.props.placement === 'widget'
    if (narrow) {
      return <Text>{statusLine() ?? 'Stackside: idle'}</Text>
    }

    const header = (
      <Box flexDirection="row" gap={1}>
        <Button key="tab-browser" variant={tab === 'browser' ? 'primary' : undefined} onPress={() => { tab = 'browser'; redraw($); void grabFrame($) }}>Browser</Button>
        <Button key="tab-debugger" variant={tab === 'debugger' ? 'primary' : undefined} onPress={() => { tab = 'debugger'; void refresh($, true) }}>
          {`Debugger${w?.paused || n?.paused ? ' ⏸' : ''}`}
        </Button>
        <Text dimColor>{busy ? busy + '…' : (statusLine() ?? 'idle')}</Text>
      </Box>
    )
    const error = lastError ? <Text color="red">{lastError.slice(0, 600)}</Text> : null

    if (tab === 'browser') {
      const visibleInChrome = !!w?.visible
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Input key="url" label="URL" value={w?.url && w.url !== 'about:blank' ? w.url : ''} placeholder="http://localhost:4200" submitLabel="go"
            onSubmit={value => { const url = value.trim() || 'http://localhost:4200'; void act($, 'Opening', () => call($, 'web_open', { url })) }} />
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="back" onPress={() => act($, 'Back', () => call($, 'web_nav', { action: 'back' }))}>◀</Button>
            <Button key="reload" onPress={() => act($, 'Reloading', () => call($, 'web_nav', { action: 'reload' }))}>⟳</Button>
            <Button key="fwd" onPress={() => act($, 'Forward', () => call($, 'web_nav', { action: 'forward' }))}>▶</Button>
            <Button key="up" onPress={() => act($, '', () => call($, 'web_scroll', { dy: -500 }))}>Scroll ↑</Button>
            <Button key="down" onPress={() => act($, '', () => call($, 'web_scroll', { dy: 500 }))}>Scroll ↓</Button>
            <Button key="elements" onPress={async () => {
              showElements = !showElements
              if (showElements) { try { const s = await call<{ items: string[] }>($, 'web_snapshot'); elements = s.items } catch (err) { lastError = String(err) } }
              redraw($)
            }}>{showElements ? 'Hide elements' : 'Elements'}</Button>
            <Button key="chrome" variant="primary" onPress={() => act($, visibleInChrome ? 'Bringing back' : 'Opening in Chrome', () => call($, 'web_show', { visible: !visibleInChrome }))}>
              {visibleInChrome ? 'Bring back here' : 'Open in Chrome'}
            </Button>
          </Box>
          {error}
          {visibleInChrome && <Text dimColor>This page is also showing in a Chrome window: same tab, same sign-in, breakpoints still on. Use either.</Text>}
          {!w?.running && <Text dimColor>No browser yet. Enter a URL above, run /debug-web localhost:4200, or ask Claude to open the app.</Text>}
          {w?.paused && <Text color="yellow">{`Page paused at ${where(w.paused.at)}: open the Debugger tab to step.`}</Text>}
          {w?.running && frame && Svg && (
            <Box position="relative" flexDirection="column">
              <Svg source={svgFor(frame)} alt={`${w.title || 'page'}: ${w.url}`} />
              {Client && (
                <Box position="absolute" top={0} left={0} right={0} bottom={0}>
                  <Client key="pad" module="./clickpad.tsx" props={{ hint: 'click' }} width="100%" height="100%" />
                </Box>
              )}
            </Box>
          )}
          {w?.running && !Svg && <Text dimColor>{`${w.title} (${w.url}): this surface can't draw the page; use Open in Chrome.`}</Text>}
          {w?.running && (
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Input key="type" label="Type" placeholder="text for the focused field (Enter sends it)" submitLabel="type"
                onSubmit={value => act($, 'Typing', () => call($, 'web_type', { text: value }))} />
              <Button key="k-enter" onPress={() => act($, '', () => call($, 'web_key', { key: 'Enter' }))}>Enter</Button>
              <Button key="k-tab" onPress={() => act($, '', () => call($, 'web_key', { key: 'Tab' }))}>Tab</Button>
              <Button key="k-esc" onPress={() => act($, '', () => call($, 'web_key', { key: 'Escape' }))}>Esc</Button>
              <Button key="k-bs" onPress={() => act($, '', () => call($, 'web_key', { key: 'Backspace' }))}>⌫</Button>
            </Box>
          )}
          {w?.running && (
            <Input key="clicktext" label="Click" placeholder="visible text of a button or link, e.g. Save" submitLabel="click"
              onSubmit={value => act($, 'Clicking', () => call($, 'web_click', { text: value.trim() }))} />
          )}
          {showElements && (
            <Box flexDirection="column">
              {elements.slice(0, 40).map(item => {
                const ref = Number(item.split(':')[0])
                return (
                  <Button key={'el-' + ref} variant="secondary" onPress={() => act($, 'Clicking', async () => { await call($, 'web_click', { ref }); const s = await call<{ items: string[] }>($, 'web_snapshot'); elements = s.items })}>{item.slice(0, 90)}</Button>
                )
              })}
            </Box>
          )}
        </Box>
      )
    }

    // ----- debugger tab -----
    const stepRow = (who: 'dotnet' | 'js') => (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button key={who + '-cont'} variant="primary" onPress={() => act($, 'Continuing', () => call($, who + '_step', { action: 'continue' }))}>Continue</Button>
        <Button key={who + '-over'} onPress={() => act($, 'Stepping', () => call($, who + '_step', { action: 'over' }))}>Step over</Button>
        <Button key={who + '-into'} onPress={() => act($, 'Stepping', () => call($, who + '_step', { action: 'into' }))}>Step into</Button>
        <Button key={who + '-out'} onPress={() => act($, 'Stepping', () => call($, who + '_step', { action: 'out' }))}>Step out</Button>
      </Box>
    )
    const pauseBlock = (who: 'dotnet' | 'js', p: Pause | null) => {
      if (!p?.paused) return null
      const frames = (p.frames ?? []).slice(0, 12)
      const locals = (p.locals ?? []).slice(0, 40).map(v => `${v.name}${v.type ? ' : ' + v.type : ''} = ${v.value}`).join('\n')
      const ex = p.exception ? (typeof p.exception === 'string' ? p.exception : JSON.stringify(p.exception, null, 1)) : ''
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="yellow" bold>{`⏸ ${where(frames.find(f => f.file) ?? frames[0])}  (${p.reason ?? 'paused'})`}</Text>
          {ex && <Text color="red">{ex.slice(0, 800)}</Text>}
          {stepRow(who)}
          <Text bold>Call stack</Text>
          <Box flexDirection="column">
            {frames.map((f, i) => <Text key={who + '-f' + i} dimColor={!f.file}>{`${i === 0 ? '→' : ' '} ${f.fn ?? ''}  ${f.file ? where(f) : '[external]'}`}</Text>)}
          </Box>
          <Text bold>Locals</Text>
          {Code ? <Code source={locals || '(none)'} /> : <Text>{locals || '(none)'}</Text>}
        </Box>
      )
    }
    const bpList = (list: Bp[], who: 'dotnet' | 'js') => list.length === 0 ? null : (
      <Box flexDirection="column">
        {list.map(b => (
          <Box key={who + '-bp-' + b.id} flexDirection="row" gap={1}>
            <Text dimColor={b.verified === false || b.resolved === null}>{`● ${String(b.file).split(/[\\/]/).pop()}:${b.line}${b.condition ? ' if ' + b.condition : ''}${b.verified === false ? ' (not bound yet)' : ''}`}</Text>
            <Button key={who + '-rm-' + b.id} variant="secondary" onPress={() => act($, 'Removing', () => call($, who + '_remove_breakpoint', { id: b.id }))}>✕</Button>
          </Box>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {error}
        <Text bold>{`.NET  ${n ? n.state + (n.project ? ' · ' + String(n.project).split(/[\\/]/).pop() : '') + (n.exitCode != null ? ' · exit ' + n.exitCode : '') : 'idle'}`}</Text>
        {pauseBlock('dotnet', netPause)}
        {n && n.state === 'running' && !n.paused && (
          <Box flexDirection="row" gap={1}>
            <Button key="dotnet-pause" onPress={() => act($, 'Pausing', () => call($, 'dotnet_step', { action: 'pause' }))}>Pause</Button>
            <Button key="dotnet-stop" onPress={() => act($, 'Stopping', () => call($, 'dotnet_stop'))}>Stop</Button>
          </Box>
        )}
        {(!n || n.state === 'idle' || n.state === 'exited') && <Text dimColor>Not debugging .NET. Run /debug-api {'<project folder>'} or ask Claude to launch or attach.</Text>}
        {bpList(netBps, 'dotnet')}
        <Text bold>{`Browser  ${w?.running ? (w.paused ? 'paused' : 'running') : 'not open'}`}</Text>
        {pauseBlock('js', webPause)}
        {w?.running && !w.paused && <Button key="js-pause" onPress={() => act($, 'Pausing', () => call($, 'js_step', { action: 'pause' }))}>Pause page</Button>}
        {bpList(webBps, 'js')}
        <Text dimColor>Ask Claude to set breakpoints, e.g. "break in OrderService.cs line 40 and in order-list.component.ts line 25".</Text>
      </Box>
    )
  })
}
