import { expect, mock, test } from 'claude-code/testing'

// The pane against a fake bridge: `mcp.call` hooks answer the bridge's tools with
// what a real paused session returns, and record what the pane asks for.

const PANE = {
  plugin: 'stackside',
  component: 'Pane',
  requestId: 'stackside',
  props: {
    title: 'Stackside',
    isFocused: true,
    bodyColumns: 90,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const SOURCE = {
  path: 'src/app/features/landing/landing.component.ts',
  line: 609,
  startLine: 607,
  lines: ['', '  ngOnInit(): void {', "    const token = this.route.snapshot.queryParamMap.get('token');", '', '    if (!token) {'],
}

let pauseAt = 1 // a new pause per surface, so the pane starts that pass fresh
const JS_STATE = {
  paused: true, at: 1, reason: 'breakpoint', breakpoint: 'js1', frame: 0, source: SOURCE,
  locals: [{ scope: 'this', name: 'this', value: '_LandingComponent', ref: 1 }, { scope: 'local', name: 'token', value: 'undefined' }],
  frames: [
    { fn: 'ngOnInit', file: 'src/app/features/landing/landing.component.ts', line: 609, column: 19 },
    // what a real Angular stack maps to: library sources, not marked generated
    { fn: 'callHookInternal', file: '../../../../../../node_modules/@angular/core/fesm2022/core.mjs', line: 5008, column: 10 },
    { fn: 'callHook', file: '../../../../../../node_modules/@angular/core/fesm2022/core.mjs', line: 5032, column: 7 },
    { fn: 'callHooks', file: '../../../../../../node_modules/@angular/core/fesm2022/core.mjs', line: 4992, column: 9 },
    { fn: 'invoke', file: 'node_modules/zone.js/fesm2015/zone.js', line: 369, column: 28 },
  ],
}

const STATUS = {
  web: { running: true, visible: false, url: 'http://localhost:4200/landing', title: 'Pastor', paused: { reason: 'breakpoint', at: JS_STATE.frames[0] }, breakpoints: 1, errors: 0 },
  dotnet: { state: 'idle', project: null, pid: null, exitCode: null, paused: null, breakpoints: 0 },
  events: [], seq: 0,
}

const answers: Record<string, (args: Record<string, unknown>) => unknown> = {
  status: () => STATUS,
  js_state: args => (args.frame === 1
    ? { ...JS_STATE, at: pauseAt, frame: 1, source: null, locals: [{ scope: 'local', name: 'hook', value: 'function ngOnInit()' }] }
    : { ...JS_STATE, at: pauseAt }),
  js_breakpoints: () => [{ id: 'js1', file: 'src/app/features/landing/landing.component.ts', line: 609, resolved: 'src/app/features/landing/landing.component.ts:609' }],
  js_variables: () => [{ name: 'route', value: 'ActivatedRoute {…}', ref: 2 }],
  js_breakpoint: () => ({ id: 'js2' }),
  js_step: () => ({ resumed: true }),
  web_eval: args => ({ value: args.expression === 'token' ? 'undefined' : '?' }),
  pane_frame: () => null,
}

test('the debugger tab shows the paused source, stack and locals, and its controls reach the bridge', async ($, on) => {
  const clock = mock.clock(on)
  const calls: { tool: string; args: Record<string, unknown> }[] = []
  on('mcp.connect', () => ({ value: { isConnected: true, server: 'stackside' } }))
  on('mcp.call', (_, e) => {
    calls.push({ tool: e.tool, args: { ...e.args } })
    const answer = answers[e.tool]
    const text = answer ? JSON.stringify(answer({ ...e.args })) : 'unknown tool'
    return { value: { content: [{ type: 'text', text }], isError: !answer } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  for (const surface of ['desktop', 'terminal'] as const) {
    calls.length = 0
    pauseAt++
    const ui = await $.ui.mount({ ...PANE, surface })
    await clock.settle()
    await ui.press({ key: 'tab-debugger' })
    await clock.settle()

    // source view: the paused line is marked, and its gutter shows the breakpoint
    expect((await ui.find({ type: 'Text', text: /▸ +const token/ }))?.text).toContain('queryParamMap')
    expect((await ui.find({ key: 'js-gut-609' }))?.text).toContain('● 609')

    // framework frames collapse after the first three
    expect(await ui.find({ key: 'js-more-3' })).toBeDefined()

    // clicking a line number sets a breakpoint there
    await ui.press({ key: 'js-gut-611' })
    expect(calls.find(c => c.tool === 'js_breakpoint')?.args).toMatchObject({ file: SOURCE.path, line: 611 })

    // expanding `this` asks for its children and shows them
    await ui.press({ key: 'js:f0/this-b' })
    expect(calls.find(c => c.tool === 'js_variables')?.args).toMatchObject({ ref: 1 })
    expect((await ui.find({ key: 'js:f0/this/route-b' }))?.text).toBe('▸ route = ActivatedRoute {…}')

    // evaluating in the selected frame
    await ui.input({ key: 'js-eval', text: 'token' })
    expect(await ui.find({ type: 'Text', text: 'token = undefined' })).toBeDefined()

    // selecting another frame asks the bridge for it
    await ui.press({ key: 'js-frb-1' })
    expect(calls.find(c => c.tool === 'js_state' && c.args.frame === 1)).toBeDefined()

    // continue goes to the page
    await ui.press({ key: 'js-cont' })
    expect(calls.find(c => c.tool === 'js_step')?.args).toMatchObject({ action: 'continue' })
    await ui.unmount()
  }
})
