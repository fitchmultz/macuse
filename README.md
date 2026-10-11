# macuse

macuse connects Pi and MCP assistants to native macOS apps. Your assistant can inspect a window or edit an approved draft, using the Computer Use runtime installed with ChatGPT.

![Pi, CLI, and MCP clients send scoped requests through macuse's guards and the installed Computer Use runtime to macOS apps; app state and screenshots return for inspection.](.github/readme/native-app-control.png)

*macuse connects your assistant to native apps; inspect the returned state before choosing the next action.*

> [!WARNING]
> **Experimental, unsupported integration.** macuse uses proprietary ChatGPT interfaces that OpenAI can change without notice. Read the [safety policy](docs/reference/codex-computer-use-safety-policy.md) before granting permissions or operating apps. Observations can reveal private content and may open an app or window.

## Install in Pi

You'll need macOS, Pi 1.0.0 or later, Node 24.21.0 or later, and ChatGPT's Computer Use installation with its authentication and macOS permissions in place. Focus observations and selected-text insertion also need Accessibility access and `xcrun swiftc`. See [local requirements](docs/reference/codex-computer-use-local-install.md) if you're setting this up for the first time.

```bash
pi install git:github.com/fitchmultz/macuse@v0.6.0
pi
```

This GitHub prerelease includes the Pi extension and its usage skill. npm publication is disabled. You can use macuse with official Pi or `fitchmultz/pi`; the [host qualification notes](docs/pi-1.0-qualification.md) cover the checks and known limits.

## Start with an observation

In Pi, ask:

> Use macuse to inspect Activity Monitor and show its current state. Do not change tabs or modify processes.

If you're calling tools directly, send this to `macuse`:

```json
{ "code": "var app = await cua.getApp(\"Activity Monitor\")", "apps": ["Activity Monitor"] }
```

Read the returned API documentation and app state. JavaScript bindings persist in that session, so the next `macuse` call can use `app`:

```json
{ "code": "await app.getAXStateAndScreenshot()", "apps": ["Activity Monitor"] }
```

Observation methods emit their results automatically. Await every action and inspect the result before deciding what to do next. Prefer a browser tool or a purpose-built API for ordinary web-page work.

## Available tools

| Tool | What it does |
| --- | --- |
| `macuse` | Inspect apps and run short JavaScript programs in a persistent session. |
| `macuse_insert_text` | Insert text at the observed selection without changing the rest of the field. |
| `macuse_reset` | Clear bindings and observations. Application state stays unchanged. |
| `macuse_tools` | Enable selected Record & Replay or Computer History tools in Pi. Enabling starts no recording. |

A new Pi session starts with these four tools. On hosts with tool discovery, enable the `macos` group first. MCP clients get all eleven tools, including recording and history. The [tool reference](docs/reference/usage.md#tools) explains how selection and saved sessions work.

Starting a recording or resuming Computer History needs explicit recording permission. Privacy-setting changes also need approval and a fresh settings read. Status and settings can contain private activity metadata; see [recording and history](docs/reference/codex-computer-use-safety-policy.md#recording-and-history) before using them.

## Making changes

Have the assistant inspect the right app and document before changing anything. Each app-changing call needs an exact `apps` scope, `allowMutating:true`, and a nonempty `safetyNote` that says what to change and where to stop. Your request supplies the permission; these fields record it.

macuse refreshes app state and checks the document and target before each action. These checks do not guarantee uninterrupted keyboard or mouse use. A timeout or reset cannot undo a GUI action: inspect fresh state after an error, and never automatically replay an action with an unknown outcome.

See [action and text-input examples](docs/reference/usage.md#act-within-the-approved-task) for guarded actions, selected-text insertion, Unicode paste, and screenshot saving.

## CLI and MCP

For the CLI or an MCP client such as Cursor, clone the repo and install its dependencies. You'll need Node 24.21.0 or later:

```bash
git clone https://github.com/fitchmultz/macuse.git
cd macuse
npm ci --ignore-scripts
node tools/macuse.mjs tools --pretty
node tools/macuse-config.mjs cursor --pretty
```

Copy the generated config into your MCP client. It points to this checkout, so keep the checkout in place. [MCP setup](docs/reference/cursor-mcp-setup.md) covers client configuration and permissions.

For multiple CLI calls sharing bindings, use `node tools/macuse.mjs session`; each input line is a JSON request. Separate `call` processes do not share state. See [CLI examples](docs/reference/usage.md#cli-and-mcp).

## Next steps

- [Tool and session reference](docs/reference/usage.md): complete examples, lifecycle rules, image handling, and runtime boundaries.
- [Local requirements](docs/reference/codex-computer-use-local-install.md): installation, permissions, SDK selection, and updates. Restart Pi after dependency or native-runtime changes; restart CLI/MCP processes after updates too.
- [Validation and diagnostics](docs/reference/demo-and-doctor.md): offline checks, read-only doctor, controlled live checks, and troubleshooting.
- [Documentation index](docs/README.md): architecture, migration, host qualification, and the agent usage skill.
- [Changelog](CHANGELOG.md): release history and breaking changes.

## License

[MIT](LICENSE) · Created by [Mitch Fultz](https://github.com/fitchmultz).
