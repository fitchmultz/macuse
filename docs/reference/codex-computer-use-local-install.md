# Codex Computer Use Local Install

Source: Local filesystem paths under `/Users/yourname/.codex/computer-use`, `/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use`, and `/Applications/ChatGPT.app`
Author: [OpenAI](https://openai.com/)
Posted: Not applicable; local installed app and plugin cache
Scraped: May 22, 2026
Refreshed: May 22, 2026 09:35 MDT after the Codex host app update, external-harness TCC probes, app-server bridge validation, and guarded Calculator click/key validation. Spot-checked again June 8 and July 18, 2026. Updated August 4, 2026 for current Computer Use schemas and Pi 0.83.0.
Observed install metadata at May 22 refresh time: Codex host app `26.519.31651` build `3017`; Computer Use plugin still `1.0.799`; app bundle `com.openai.sky.CUAService`; notarized Developer ID app from OpenAI
Current August 4 spot-check: ChatGPT host app `26.727.51351` build `6119` (bundle ID remains `com.openai.codex`); bundled Codex CLI `0.146.0-alpha.9.2`; Computer Use plugin `1.0.1000550`; Computer Use client `26.727.1000550`. Macuse configures `computer-use`/`mcp` (10 tools), `event-stream`/`event-stream mcp` (3), and `computer-history`/`computer-history mcp` (5). The client also exposes a separate Messages MCP that macuse intentionally excludes. Discover the cache version at runtime rather than using historical fallback paths.

The host app, Codex CLI, and bundled Computer Use plugin now live inside
`/Applications/ChatGPT.app`. The separate Computer Use service also remains
installed under the Codex home folder. May/June version and hash observations
below are retained as historical snapshots where explicitly dated.

For external-harness findings, probes, and refresh commands, see
[`codex-computer-use-external-harness.md`](./codex-computer-use-external-harness.md).

## Current host app

| Purpose | Path / value |
| --- | --- |
| Host app | `/Applications/ChatGPT.app` |
| Bundle ID | `com.openai.codex` |
| App version | `26.727.51351` |
| Build version | `6119` |

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
| Short version | `1.0` |
| Build version | `799` |
| Architecture | arm64 |
| App bundle size | 51 MB |
| Signing authority | `Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)` |
| Gatekeeper assessment | accepted; source `Notarized Developer ID` |
| Code-signing timestamp | May 20, 2026 20:53:49 MDT |
| CDHash | `e4a001c307d2541c9930a24b56ce833af6356d70` |

The app entitlements observed were:

- `com.apple.security.application-groups`: `2DC432GLL2.com.openai.sky.CUAService`
- `com.apple.security.automation.apple-events`: `true`

## Shared support apps and authorization plugin

| Component | Bundle ID | Executable | Version / build | Path |
| --- | --- | --- | --- | --- |
| Codex Computer Use Installer | `com.openai.sky.CUAService.AuthorizationPluginInstaller` | `Codex Computer Use Installer` | `0.1.0` / `799` | `/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app` |
| SkyComputerUseClient | `com.openai.sky.CUAService.cli` | `SkyComputerUseClient` | `1.0` / `799` | `/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app` |
| CUALockScreenGuardian | `com.openai.sky.CUAService.guardian` | `CUALockScreenGuardian` | `1.0` / `799` | `/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/CUALockScreenGuardian.app` |
| CodexComputerUseAuthorizationPlugin | `com.openai.sky.CUAService.AuthorizationPlugin` | `CodexComputerUseAuthorizationPlugin` | `0.1.0` / `799` | `/Users/yourname/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/Codex Computer Use Installer.app/Contents/Resources/CodexComputerUseAuthorizationPlugin.bundle` |

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
/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.799
```

The ChatGPT host app contains the bundled copy used by macuse at:

```text
/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use
```

Relevant files in that cache:

| Purpose | Path |
| --- | --- |
| Plugin manifest | `/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.799/.codex-plugin/plugin.json` |
| MCP config | `/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.799/.mcp.json` |
| Cached app bundle | `/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.799/Codex Computer Use.app` |
| Computer Use skill | `/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.799/skills/computer-use/SKILL.md` |
| Plugin icon | `/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.799/assets/app-icon.png` |

The plugin manifest identifies the plugin as:

- Name: `computer-use`
- Version: `1.0.799`
- Description: `Control desktop apps on macOS from Codex through Computer Use.`
- Author: OpenAI
- License: Proprietary

The MCP server entry points at the bundled client executable:

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "./Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
      "args": ["mcp"],
      "cwd": "."
    }
  }
}
```

At refresh time, only `1.0.799` was present under the bundled Computer Use cache;
no newer Computer Use cache version was found. The main service and client
executable hashes matched between the primary install, cached plugin copy, and
host-app bundled copy.

## App-specific instruction resources

The Computer Use client bundle includes app-specific instruction files at:

```text
/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.799/Codex Computer Use.app/Contents/Resources/Package_ComputerUseClient.bundle/Contents/Resources/AppInstructions
```

Files observed there:

- `AppleMusic.md`
- `Clock.md`
- `iPhone Mirroring.md`
- `Notion.md`
- `Numbers.md`
- `Spotify.md`

Copies also exist inside the bundled `SkyComputerUseClient.app` and
`CUALockScreenGuardian.app` resources.

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
- The bundled `.mcp.json` registers a `computer-use` server with command
  `SkyComputerUseClient` and args `["mcp"]`.
- A direct MCP probe from this shell succeeded for `initialize` and `tools/list`
  without running through Codex.

A non-Codex MCP-capable harness can use the bundled plugin copy with a config
like this for **direct raw-MCP discovery and denial-path tests**:

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "./Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
      "args": ["mcp"],
      "cwd": "/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.799"
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
  "version": "d10a51766bb4d162ef1eed308e86a0f8f3816fb860896cb92c18e6de998142af"
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

It then creates an ephemeral app-server thread, explicitly configures the
`computer-use`, `event-stream`, and `computer-history` transports from the
ChatGPT-bundled plugin, verifies their paginated thread-scoped inventories, and
calls the selected server through `mcpServer/tool/call`. The explicit transports
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
  This bridge intentionally does not add a second per-app confirmation layer when
  Codex's Any App setting is enabled; it defaults to `approval: "inherit"` and
  still keeps hard stop boundaries for high-risk actions.
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

## Search notes from refresh

- The Codex host app update was visible at `/Applications/Codex.app`, version
  `26.519.31651` build `3017`.
- No newer Computer Use plugin cache was found; only
  `/Users/yourname/.codex/plugins/cache/openai-bundled/computer-use/1.0.799`
  existed at refresh time.
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
