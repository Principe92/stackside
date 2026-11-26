[![M8ven Score](https://m8ven.ai/badge/mcp/principe92-stackside-amy864?v=63b2668b12e186c10d5ae43e5b870966)](https://m8ven.ai/mcp/principe92-stackside-amy864?s=readme)

# Stackside

**Debug your web frontend and .NET backend without leaving Claude Code.**

Stackside is a Claude Code plugin (a mod) that adds a debugging pane beside the chat and gives Claude the same
controls as tools:

- **A browser you drive from Claude Code.** Stackside runs its own Chrome (separate profile, kept off-screen) and
  shows the page live in the pane: address bar, back / reload, scroll, typing, keys, click by element. Press
  **Open in Chrome** to move that *same* window onto your screen (same tab, same sign-in, breakpoints still on), and
  **Bring back here** to hide it again.
- **TypeScript breakpoints in the browser**, mapped through your dev server's source maps (Angular `ng serve`, Vite,
  webpack): pause, step, call stack in `.ts` files, locals, evaluate in the paused frame, console and network logs.
- **.NET debugging** with [netcoredbg](https://github.com/Samsung/netcoredbg): build and launch (or attach to) an
  ASP.NET Core / .NET project using its `launchSettings.json` profile, C# breakpoints (with conditions), break on
  exceptions, step, locals, expand objects, evaluate C# expressions, and see the app's console output.

Because Claude has the same controls, you can ask for a whole debugging session in one go:

> Put a breakpoint in `OrderService.cs` on the line that computes the total, launch the API, open
> `localhost:4200/orders`, add an item to the cart and check out, then tell me why `total` is null.

---

## Requirements

| | |
|---|---|
| **Claude Code** | A recent version with plugin mods (the desktop app's Code tab, or the `claude` CLI). |
| **Node.js 22+** | Runs the bridge. It uses Node's built-in `WebSocket`, so 22 or newer. `node --version` to check. |
| **Chrome or Edge** | For the browser side. Found in the usual install locations; or set `STACKSIDE_CHROME`. |
| **.NET SDK** | For the backend side (`dotnet --list-sdks`). Any SDK that builds your project. |

Tested on Windows 11 with .NET 8 and Angular 18. macOS and Linux builds of netcoredbg exist and the code handles
them, but they are less tested.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin marketplace add principe92/stackside
/plugin install stackside@stackside
```

If asked for a scope, pick user scope to make it available in every session.

From a shell (installs at user scope):

```
claude plugin marketplace add principe92/stackside
claude plugin install stackside@stackside
```

To update later, run `claude plugin update stackside@stackside` and restart Claude Code.

In the desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**,
**Add marketplace** with `principe92/stackside`, then **Add plugin**.

### One-time setup: the .NET debugger

The .NET side needs netcoredbg, which is not bundled here. Ask Claude:

> Set up the Stackside .NET debugger.

Claude runs the `dotnet_setup` tool, which downloads the right netcoredbg release for your machine (about 3.5 MB,
MIT licensed, from [github.com/Samsung/netcoredbg/releases](https://github.com/Samsung/netcoredbg/releases)) into
the plugin's data folder. Alternatively, download it yourself and either put `netcoredbg` on your `PATH` or set
`STACKSIDE_NETCOREDBG` to the executable's full path.

The browser side needs no setup.

## Use it

### Commands

| Command | What it does |
|---|---|
| `/stackside` | Open the Stackside pane |
| `/debug-web localhost:4200` | Open a URL in the debug browser (defaults to `http://localhost:4200`) |
| `/debug-api C:\src\MyApp` | Build and launch a .NET project under the debugger (a `.csproj`, its folder, or a solution folder with one web project) |
| `/debug-stop` | End the .NET debug session |

### The pane

- **Browser tab:** a picture of the page, the URL bar, ◀ ⟳ ▶, scroll, a **Type** field and Enter / Tab / Esc / ⌫
  keys, a **Click** field (type a button's visible text), and **Elements**, a clickable list of the page's buttons,
  links and fields. The picture updates after each action, yours or Claude's; **Update picture** refreshes it
  when the page changes by itself. **Open in Chrome** hands the window to you; **Bring back here** takes it back.
- **Debugger tab:** for .NET and for the browser, where execution is paused and why, Continue / Step over /
  Step into / Step out, the call stack, the locals, and the breakpoints (✕ removes one).
- **Status line:** shows `⏸ .NET OrderService.cs:57` or `● web localhost:4200/orders` while you work, and a toast
  pops up when a breakpoint hits.

### A typical session

1. Start your frontend dev server as usual (`ng serve`, `npm run dev`).
2. Ask Claude to set breakpoints, or set them yourself through Claude: *"break in OrderService.cs line 40 and in
   order-list.component.ts line 25"*.
3. `/debug-api <your API folder>`, then `/debug-web localhost:4200`.
4. Use the app from the pane (or press **Open in Chrome** and use it there). When a breakpoint hits, the Debugger
   tab shows where, and you or Claude can inspect and step.

Sign in to your app once in the debug browser (for example with **Open in Chrome**). Its profile is kept, so the
sign-in survives restarts.

## Tools Claude gets

| Area | Tools |
|---|---|
| Browser | `web_open`, `web_nav`, `web_snapshot`, `web_screenshot`, `web_click`, `web_type`, `web_key`, `web_scroll`, `web_eval`, `web_console`, `web_network`, `web_response`, `web_show` |
| TypeScript | `js_breakpoint`, `js_breakpoints`, `js_remove_breakpoint`, `js_exceptions`, `js_step`, `js_state` |
| .NET | `dotnet_setup`, `dotnet_launch`, `dotnet_attach`, `dotnet_stop`, `dotnet_breakpoint`, `dotnet_breakpoints`, `dotnet_remove_breakpoint`, `dotnet_exceptions`, `dotnet_step`, `dotnet_state`, `dotnet_variables`, `dotnet_eval`, `dotnet_output` |
| Both | `status` |

They also work without the pane, for example in a terminal session.

## How it works

```
Claude Code ──MCP (stdio)──▶ bridge/server.mjs ──Chrome DevTools Protocol──▶ Chrome (own profile, off-screen)
     ▲                              │
     │ pane, commands,              └──Debug Adapter Protocol──▶ netcoredbg ──▶ your .NET app
     │ status line
hooks/register.tsx
```

- `bridge/` is a dependency-free Node MCP server. `web.mjs` drives Chrome over the DevTools protocol, `sourcemap.mjs`
  maps TypeScript lines to the generated JavaScript and back, and `dotnet.mjs` speaks the Debug Adapter Protocol to
  netcoredbg.
- `hooks/` is the Claude Code mod: the pane, the slash commands and the status line. It talks to the bridge through
  Claude Code's MCP connection.
- The debug Chrome keeps running when Claude Code exits, so a session you handed off to Chrome isn't lost. Close
  it like any Chrome window.

## Configuration

| Environment variable | Default | Purpose |
|---|---|---|
| `STACKSIDE_CHROME` | Chrome / Edge in their usual locations | Browser executable to use |
| `STACKSIDE_CHROME_PORT` | `9333` | Remote-debugging port of the debug Chrome |
| `STACKSIDE_NETCOREDBG` | the copy `dotnet_setup` installed, else `PATH` | netcoredbg executable |

## Troubleshooting

- **The API never finishes starting.** Pause it from the Debugger tab (or ask Claude) and read the call stack. A
  common cause in Development is an interactive Azure sign-in (`InteractiveBrowserCredential`, for example for Key
  Vault) waiting for you in a browser window.
- **A TypeScript breakpoint says "pending".** It binds when a script containing that file loads, for example when
  you navigate to a lazy-loaded route.
- **A C# breakpoint isn't verified.** It binds once the assembly with that file loads; check that the line has code
  on it and that you launched a Debug build.
- **Clicking the page picture does nothing.** It is a picture: use **Elements**, the **Click** field, or
  **Open in Chrome**.
- **The pane flickers now and then.** The desktop app redraws the pane after each call it makes to the bridge, so
  the pane only checks for changes (every 3 seconds) while a debug session could pause on its own: a running .NET
  app, a browser breakpoint, or the page open in Chrome.
- **Port 9333 is in use.** Set `STACKSIDE_CHROME_PORT` to a free port.

## Develop

Run Claude Code with the plugin loaded from your clone:

```
claude --plugin-dir /path/to/stackside
```

Check it with `claude plugin validate /path/to/stackside`.

## License

[MIT](LICENSE) © 2026 Princewill Okorie.

netcoredbg is © Samsung Electronics and MIT licensed. It is downloaded separately and is not part of this
repository.
