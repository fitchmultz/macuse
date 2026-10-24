# macuse

macuse connects Pi and MCP assistants to native macOS apps through the Computer Use runtime installed with ChatGPT. Use it to inspect app windows and edit approved documents.

![Pi, CLI, and MCP clients send requests through macuse and the installed Computer Use runtime to macOS apps. App state returns to the client.](.github/readme/native-app-control.png)

*macuse checks the app and document before each action. The assistant receives app state, screenshots, and action results.*

> [!WARNING]
> **Experimental, unsupported integration.** OpenAI can change these private interfaces without notice. Read the [safety policy](docs/reference/codex-computer-use-safety-policy.md) before you grant permissions or use app actions.
>
> App observations can show private content from open app windows. App reads can open an app window. Keep app captures private unless you have permission to share them.

## Install in Pi

Use macOS, Pi 1.0.0 or later, and Node 24.21.0 or later. Set up ChatGPT Computer Use with its normal authentication and macOS permissions.

Native focus checks and selected-text insertion also require Accessibility access and `xcrun swiftc`. See [local requirements](docs/reference/codex-computer-use-local-install.md) for setup details.

```bash
pi install git:github.com/fitchmultz/macuse
pi
```

The package includes the Pi extension and usage skill. npm publication is disabled. macuse supports official Pi and `fitchmultz/pi`; see the [host qualification notes](docs/pi-1.0-qualification.md) for checked versions and limits.

Restart Pi after dependency or native runtime changes.

## First use

Ask Pi:

> Use macuse to inspect Activity Monitor. Do not change tabs or modify processes.

For a direct call, send this input to `macuse`:

```json
{ "code": "var app = await cua.getApp(\"Activity Monitor\")", "apps": ["Activity Monitor"] }
```

The tool returns API documentation and app state. Bindings persist until reset or a session boundary. Await each action. Inspect its result before you choose the next action.

## Tools

| Tool | Purpose |
| --- | --- |
| `macuse` | Inspect apps and run JavaScript in a persistent session. |
| `macuse_insert_text` | Replace selected text without changes to the rest of the field. |
| `macuse_reset` | Clear bindings and observations; preserve app state. |
| `macuse_tools` | Enable Record & Replay or Computer History tools in Pi. |
| `macuse_enable` | Select the four entry tools permitted by Pi. |

Pi starts with four entry tools and the separate recovery tool. Enable the `macos` group on Pi hosts with tool discovery. MCP exposes eleven tools, including the eight Record & Replay and Computer History tools. Tool activation starts no recording.

### Saved-session recovery

If macuse tools are missing from a saved session, run `/macuse-enable`. The assistant can also call `macuse_enable({})` when that recovery tool is active. Saved loadouts can omit it; reloading an already registered tool does not explicitly select it.

Recovery preserves other tool selections and host restrictions. It starts no app control or service. See [saved-session recovery](docs/reference/usage.md#saved-session-recovery) for discovery steps and selection limits.

## App changes and limits

Observe the target app before each change. Each change needs an exact app scope (`apps` or `app`), `allowMutating:true`, and a nonempty `safetyNote`. Describe the target, effect, and stop boundary in the safety note. These fields record the permission in your request.

Inspect fresh app state after an error. Never automatically replay a dispatched action or an action with an unknown result. Timeouts and resets do not undo app changes. macuse does not guarantee uninterrupted keyboard or mouse use.

Recording and privacy changes require explicit permission. Status and settings can expose private activity metadata. See the [tool reference](docs/reference/usage.md) for examples and the complete safety gates.

Use a browser tool for ordinary web pages.

## CLI and MCP

Clone the repository for CLI or MCP use:

```bash
git clone https://github.com/fitchmultz/macuse.git
cd macuse
npm exec --yes --package=npm@12.2.1 -- npm ci --ignore-scripts
node tools/macuse.mjs tools --pretty
node tools/macuse-config.mjs cursor --pretty
```

Copy the generated config into your MCP client. Keep this checkout in place; the config uses its paths. Follow [MCP setup](docs/reference/cursor-mcp-setup.md) for client configuration.

Use npm 12.2.0 or later in the 12.x series for source installs and development. The command above uses the pinned resolver without replacing your global npm. Older npm versions can silently ignore the Pi development dependency's security override when regenerating the lockfile; `devEngines` rejects them before installation. For development commands, use a supported npm version or the same `npm exec` prefix. Node and Pi support floors are unchanged.

Use `node tools/macuse.mjs session` for calls that share bindings. Each input line contains a JSON request. Separate `call` processes do not share bindings. Restart CLI and MCP processes after updates.

## Further reading

- [Tool reference](docs/reference/usage.md): full examples and session behavior.
- [Local requirements](docs/reference/codex-computer-use-local-install.md): permissions, updates, and SDK setup.
- [Validation and diagnostics](docs/reference/demo-and-doctor.md): offline checks and live check scopes.
- [Documentation index](docs/README.md): architecture, migration, and host qualification.
- [Changelog](CHANGELOG.md): release history and breaking changes.

## License

[MIT](LICENSE) · Created by [Mitch Fultz](https://github.com/fitchmultz).
