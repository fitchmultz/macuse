# Local requirements and installation

macuse v0.5.0 is an experimental GitHub prerelease installed in Pi from Git, not npm. Its `private: true` package metadata prevents npm publication. It reuses proprietary software already installed with ChatGPT; external-host use is unsupported and interfaces can change with vendor updates.

## Requirements

- macOS with ChatGPT and its Computer Use installation configured through the vendor's normal setup.
- Access to the installed `@oai/cua-repl`, bundled Node/kernel, and native Sky service.
- Existing vendor authentication and the macOS permissions required by the responsible launcher, including applicable Screen Recording, Accessibility, and Automation grants.
- An installed Swift compiler (`xcrun swiftc`) for macuse's native AX helper. The helper compiles lazily, caches by source hash under `~/Library/Caches/macuse/native`, and needs Accessibility access for focus/window/text operations.
- For Pi, latest stable official Pi or `fitchmultz/pi` 0.87.0. macuse uses their shared public extension APIs; Pi runtime dependencies come from the host.
- For CLI/MCP, Node 24.21.0 or later and installed repository dependencies.

macuse does not install the vendor runtime/compiler, change user settings, grant permissions, or bypass authentication. Missing requirements should produce a concrete setup error, not a fallback input system.

## Install in Pi

```bash
pi install git:github.com/fitchmultz/macuse@v0.5.0
```

The package supplies `extensions/macuse.ts` and `skills/macuse/SKILL.md`. A local checkout can instead be installed with `pi install /absolute/path/to/macuse`.

Quit Pi and start a new process after install/update or extension/dependency changes. `/reload` refreshes resources and activation but does not replace loaded extension code. Restart CLI/MCP processes after changes too; a new process picks up native helper source changes through the source-hash cache.

Four tools start active: `macuse`, `macuse_insert_text`, `macuse_reset`, and `macuse_tools`. The eight recording/history tools remain inactive until the loader enables them. No host patches or image-sizing settings edits are required for Astra.

## Installed paths

Default paths are resolved from the local installation rather than copied versioned caches:

| Component | Default location |
| --- | --- |
| ChatGPT resources | `/Applications/ChatGPT.app/Contents/Resources` |
| Native runtime launch manifest | `/Applications/ChatGPT.app/Contents/Resources/cua_node/manifest.json` |
| Vendor Node packages | The manifest's `node_modules` directory, containing `@oai/cua-repl` and `@oai/sky` |
| Computer Use service | `$CODEX_HOME/computer-use/Codex Computer Use.app` |
| Auxiliary Codex binary | `/Applications/ChatGPT.app/Contents/Resources/codex` |
| Auxiliary plugin roots | ChatGPT resources under `plugins/openai-bundled/plugins/record-and-replay` and `computer-history` |

`CODEX_HOME` retains its existing scope, normally `~/.codex`. `MACUSE_CHATGPT_RESOURCES` selects resources for both runtimes; `CODEX_BIN` can override the auxiliary app-server executable. MCP's `MACUSE_CWD` selects its session working directory. Do not point these at untrusted code or discard authentication context to make a probe pass.

## Permission troubleshooting

A terminal, Pi host, and MCP client can have different responsible-launcher grants. Successful app enumeration or protocol discovery does not prove permission to read/control a particular app. Native AX access and vendor app approval are also separate checks.

For AppleEvents errors such as `-609`, `-1712`, or `-1743`, inspect the responsible launcher and Automation/TCC evidence before concluding the runtime is down. Use the normal system/vendor permission flow. Do not edit TCC databases or disable privacy controls as a shortcut. A locked console or missing window is a separate condition; ask the user to unlock or open the intended app when necessary.

```bash
node tools/macuse-doctor.mjs --out .scratch/doctor
```

Doctor is read-only unless `--full` is explicitly requested. Its results describe the current launcher, not all hosts. See [validation and diagnostics](demo-and-doctor.md) and [dated investigation notes](codex-computer-use-external-harness.md#historical-findings).
