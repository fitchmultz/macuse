# Codex Computer Use Local Install

Source: Local filesystem paths under `/Users/yourname/.codex/computer-use`, `/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use`, and `/Applications/ChatGPT.app`
Author: [OpenAI](https://openai.com/)
Posted: Not applicable; local installed app and plugin cache
Scraped: May 22, 2026
Refreshed: May 22, 2026 09:35 MDT after the Codex host app update and external-harness probes. Spot-checked June 8 and July 18; updated August 6; refreshed August 17, 2026 for current ChatGPT plugins, launchers, and Pi 0.84.0+.
Observed install metadata at May 22 refresh time: Codex host app `26.519.31651` build `3017`; Computer Use plugin still `1.0.799`; app bundle `com.openai.sky.CUAService`; notarized Developer ID app from OpenAI
Current August 17 spot-check: ChatGPT host app `26.810.52044` build `6662` (bundle ID remains `com.openai.codex`); bundled Codex CLI `0.148.0-alpha.9`; Computer Use, Record & Replay, and Computer History plugins `1.0.1000717`; Computer Use client `26.727.1000550`. Macuse configures `computer-use`/`mcp` (10 tools), `event-stream`/`event-stream mcp` (3), and `computer-history`/`computer-history mcp` (5) from each current plugin launcher. The client also exposes a separate Messages MCP, and app-server advertises `node_repl`; macuse intentionally excludes both.

The host app, Codex CLI, and bundled Computer Use plugin now live inside
`/Applications/ChatGPT.app`. The separate Computer Use service also remains
installed under the Codex home folder. May/June version and hash observations
below are retained as historical snapshots where explicitly dated.

For external-harness findings, probes, and refresh commands, see
[`codex-computer-use-external-harness.md`](./codex-computer-use-external-harness.md).

Related local host-app state found:

- `/Users/yourname/Library/Application Support/Codex`
- `/Users/yourname/.codex/version.json` reported latest CLI/runtime version
  `0.132.0` with `last_checked_at` `2026-05-21T14:36:40.370977Z`.

## Primary Computer Use install paths

| Purpose | Path |
| --- | --- |
| Install directory | `/Users/yourname/.codex/computer-use` |
| App bundle | `/Users/yourname/.codex/computer-use/Codex Computer Use.app` |
| Local config | `/Users/yourname/.codex/computer-use/config.json` |
| Main executable | `/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService` |
| Main `Info.plist` | `/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/Info.plist` |
| App icon | `/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/Resources/CUAAppIcon.icns` |

## Computer Use bundle identity

| Field | Value |
| --- | --- |
| App name | `Codex Computer Use` |
| Bundle ID | `com.openai.sky.CUAService` |
| Executable | `SkyComputerUseService` |
| Short version | `26.727.1000550` |
| Build version | `1000550` |
| Architecture | arm64 |
| App bundle size | 63 MB |
| Signing authority | `Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)` |
| Gatekeeper assessment | accepted; source `Notarized Developer ID` |

The app entitlements observed were:

- `com.apple.security.application-groups`: `2DC432GLL2.com.openai.sky.CUAService`
- `com.apple.security.automation.apple-events`: `true`

## Shared support apps and authorization plugin

| Component | Bundle ID | Executable | Version / build | Path |
| --- | --- | --- | --- | --- |
| Codex Computer Use Installer | `com.openai.sky.CUAService.AuthorizationPluginInstaller` | `Codex Computer Use Installer` | `26.727.1000550` / `1000550` | `/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app` |
| SkyComputerUseClient | `com.openai.sky.CUAService.cli` | `SkyComputerUseClient` | `26.727.1000550` / `1000550` | `/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app` |
| CUALockScreenGuardian | `com.openai.sky.CUAService.guardian` | `CUALockScreenGuardian` | `26.727.1000550` / `1000550` | `/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/CUALockScreenGuardian.app` |
| CodexComputerUseAuthorizationPlugin | `com.openai.sky.CUAService.AuthorizationPlugin` | `CodexComputerUseAuthorizationPlugin` | bundled with `1000550` | `/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app/Contents/Resources/CodexComputerUseAuthorizationPlugin.bundle` |

## Local config

`/Users/yourname/.codex/computer-use/config.json` is small and contains UI
settings only:

```json
{
  "accentColor": "#339cff",
  "direction": "ltr",
  "locale": "en-US",
  "strings": {
    "escToCancel": "Esc to cancel",
    "usingComputer": "Codex is using your computer"
  }
}
```

## Bundled Computer Use plugin copies

A matching cached Computer Use plugin copy exists at:

```text
/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.1000717
```

The ChatGPT host app contains the bundled copy used by macuse at:

```text
/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use
```

Relevant files in that cache:

| Purpose | Path |
| --- | --- |
| Plugin manifest | `/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.1000717/.codex-plugin/plugin.json` |
| MCP config | `/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.1000717/.mcp.json` |
| Computer Use skill | `/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.1000717/skills/computer-use/SKILL.md` |
| Plugin icon | `/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.1000717/assets/app-icon.png` |

The plugin manifest identifies the plugin as:

- Name: `computer-use`
- Version: `1.0.1000717`
- Description: `Control desktop apps on macOS from ChatGPT through Computer Use. Prefer purpose-built connectors, APIs, or CLIs.`
- Author: OpenAI
- License: Proprietary

The MCP server entry points at the current plugin launcher:

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "./bin/computer-use-client-launcher",
      "args": ["mcp"],
      "cwd": ".",
      "env_vars": ["CODEX_HOME"]
    }
  }
}
```

The current ChatGPT host also bundles separate `record-and-replay` and `computer-history` plugin roots at the same `1.0.1000717` version. All three use their own `computer-use-client-launcher` and family-specific arguments, while the executable itself stays in `$CODEX_HOME/computer-use`.

## App-specific instruction resources

The Computer Use client bundle includes app-specific instruction files at:

```text
/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/Resources/Package_ComputerUse.bundle/Contents/Resources/AppInstructions
```

Files observed there:

- `AppleMusic.md`
- `Clock.md`
- `iPhone Mirroring.md`
- `Notion.md`
- `Numbers.md`
- `Spotify.md`
- `Slack.md`

A copy also exists inside `CUALockScreenGuardian.app` resources.

## Use from non-Codex harnesses

Current status: read-only operation plus guarded Activity Monitor search/tab and
controlled TextEdit scroll/type/set-value/select smoke tests are proven through
the Codex app-server bridge; direct raw MCP remains useful
for discovery and denial-path probes but still hangs for accepted service-backed
calls. See
[`codex-computer-use-external-harness.md`](./codex-computer-use-external-harness.md)
for the latest external-harness probe results and refresh commands.

The installed client is technically invocable outside Codex as a standard MCP
server. Evidence:

- The client help says `mcp` "Runs the Computer Use client as an MCP server".
- The bundled `.mcp.json` registers a `computer-use` server with `./bin/computer-use-client-launcher`, args `["mcp"]`, and `CODEX_HOME` forwarding.
- A direct MCP probe from this shell succeeded for `initialize` and `tools/list`
  without running through Codex.

A non-Codex MCP-capable harness can use the bundled plugin copy with a config
like this for **direct raw-MCP discovery and denial-path tests**:

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "./bin/computer-use-client-launcher",
      "args": ["mcp"],
      "cwd": "/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.1000717",
      "env_vars": ["CODEX_HOME"]
    }
  }
}
```

Or it can use the installed app path directly:

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
      "args": ["mcp"]
    }
  }
}
```

The MCP server advertised these tools during the refresh probe:

- `list_apps`
- `get_app_state`
- `click`
- `perform_secondary_action`
- `set_value`
- `select_text`
- `scroll`
- `drag`
- `press_key`
- `type_text`

The MCP `serverInfo` returned:

```json
{
  "name": "Computer Use",
  "version": "14e7d17f1f59e77ca541a15071e980628cd08977a4dda111c96e0564d337056b"
}
```

For positive operation, use the Codex app-server bridge instead of calling
`SkyComputerUseClient mcp` directly. `status` prints compact inventories for
`computer-use`, `event-stream`, and `computer-history`; pass `--full` to inspect every
configured app-server MCP server:

```bash
node tools/codex-computer-use-appserver.mjs status --quiet --pretty
node tools/codex-computer-use-appserver.mjs list-apps --quiet --pretty
node tools/codex-computer-use-appserver.mjs get-state --app "Activity Monitor" --quiet --pretty
node tools/validate-macuse.mjs mutating
```

The bridge starts:

```bash
/Applications/ChatGPT.app/Contents/Resources/codex app-server \
  --enable computer_use \
  --enable plugins \
  --enable tool_call_mcp_elicitation
```

It sends the current `initialized` notification, creates an ephemeral app-server thread, explicitly configures the `computer-use`, `event-stream`, and `computer-history` transports from their current ChatGPT-bundled plugin launchers, waits for asynchronous startup, verifies their paginated thread-scoped inventories, and calls the selected server through `mcpServer/tool/call`. The explicit transports
prevent stale or disabled global Codex MCP config from shadowing them.

Practical limits:

- This is OpenAI's proprietary Codex Computer Use plugin, so non-Codex use may be
  unsupported even though the MCP/app-server surfaces are present.
- Real UI control still depends on macOS permissions such as Screen Recording,
  Accessibility, Automation, and app-specific approval state.
- External-harness probes showed macOS TCC evaluating the responsible host app
  during `SkyComputerUseClient` -> `SkyComputerUseService` Apple Events. In one
  pi-hosted probe the responsible app was Repo Prompt (`com.pvncher.repoprompt`),
  and the service logged `TCC RESULT:SkCu/XpcB = rejected`. Later iTerm-hosted
  raw-MCP probes logged Apple Events acceptance but still timed out, so TCC
  acceptance is required for some hosts but not the whole direct raw-MCP contract.
- A non-Codex harness must implement its own safety policy for risky UI actions.
  This bridge intentionally does not add a second per-app confirmation layer; it defaults to `approval: "inherit"` under macuse's standing app-access policy and still keeps hard stop boundaries for high-risk actions.
- Direct accepted raw-MCP service-backed probes (`get_app_state` for a target app
  and `list_apps`) timed out from external hosts. App-server-mediated read-only
  probes succeeded, which means the missing direct-MCP contract is likely around
  Codex thread/session/lifecycle wrapping rather than the low-level Computer Use
  service alone.
- Guarded direct Activity Monitor `set_value` / `perform_secondary_action` calls and controlled TextEdit scroll/type/set-value/select sequences are validated. Pi registers all 18 tools in macuse's configured scope and activates exact direct tools on demand through `macuse_tools`; broader mutations remain guarded by the local safety policy and before/after `get_app_state` evidence.

## Related user-state paths found

These paths were found under the user Library while searching for Computer Use,
SkyComputerUse, CUA, and `com.openai.sky` names:

```text
/Users/yourname/Library/Application Scripts/2DC432GLL2.com.openai.sky.CUAService
/Users/yourname/Library/Caches/com.openai.sky.CUAService
/Users/yourname/Library/Caches/com.openai.sky.CUAService.cli
/Users/yourname/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService
/Users/yourname/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/Library/Application Scripts/2DC432GLL2.com.openai.sky.CUAService
/Users/yourname/Library/HTTPStorages/com.openai.sky.CUAService
/Users/yourname/Library/HTTPStorages/com.openai.sky.CUAService.binarycookies
/Users/yourname/Library/HTTPStorages/com.openai.sky.CUAService.cli
/Users/yourname/Library/HTTPStorages/com.openai.sky.CUAService.cli.binarycookies
/Users/yourname/Library/Preferences/com.openai.sky.CUAService.plist
/Users/yourname/Library/Preferences/com.openai.sky.CUAService.cli.plist
```

The preference files include Statsig/internal cache keys and app settings, so
this reference records only their paths, not their full values.

## Historical May 22 search notes

The following bullets preserve the original May 22 filesystem snapshot and are not current install guidance.

- The Codex host app update was visible at `/Applications/Codex.app`, version
  `26.519.31651` build `3017`.
- No newer Computer Use plugin cache was found; only `/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.799` existed at that time.
- `grep` over the Codex plugin/cache area found Computer Use references only in
  the `computer-use/1.0.799` plugin and related resource bundles. It also found a
  separate bundled browser plugin at
  `/Users/yourname/.codex/plugins/cache/openai-bundled/browser/26.519.31651`,
  matching the updated Codex host app version.
- No matching `Codex Computer Use`, `SkyComputerUse`, `CUA`, or
  `com.openai.sky` paths were found under `/Library` with a bounded depth-5
  search.
- No matching `launchctl list` entries were found for `codex`, `computeruse`,
  `cua`, `openai.sky`, or `skycomputer` during the search.
- A `SkyComputerUseClient` process was running during inspection. Full process
  arguments were intentionally not copied here because they can include prompt
  and thread context.
