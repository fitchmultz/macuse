# Local requirements and installation

macuse v0.6.1 is an experimental GitHub prerelease installed in Pi from Git, not npm. Its `private: true` package metadata prevents npm publication. It reuses proprietary software already installed with ChatGPT; external-host use is unsupported and interfaces can change with vendor updates.

## Requirements

- macOS with ChatGPT and its Computer Use installation configured through the vendor's normal setup.
- Access to the installed `@oai/cua-repl`, bundled Node/kernel, and native Sky service.
- Existing vendor authentication and the macOS permissions required by the responsible launcher, including applicable Screen Recording, Accessibility, and Automation grants.
- An installed Swift compiler (`xcrun swiftc`) for macuse's native AX helper. The helper compiles lazily, caches by source hash under `~/Library/Caches/macuse/native`, and needs Accessibility access for focus/window/text operations.
- For Pi, latest stable official Pi or the maintained `fitchmultz/pi`. The supported floor and development baseline are 1.5.0; macuse uses shared public extension APIs and Pi runtime dependencies come from the host.
- For CLI/MCP, Node 24.21.0 or later and installed repository dependencies.

macuse does not install the vendor runtime/compiler, change user settings, grant permissions, or bypass authentication. Missing requirements should produce a concrete setup error, not a fallback input system.

This runtime boundary does not prohibit an agent from completing setup authorized by the user's request or standing instructions. Install needed tooling and use supported system/vendor permission flows with grants sufficient for the requested capability; do not ask again for covered setup. Hand off OS prompts or authentication that require the user, and preserve the [safety policy](codex-computer-use-safety-policy.md).

## Install in Pi

```bash
pi install git:github.com/fitchmultz/macuse
```

The package supplies `extensions/macuse.ts` and `skills/macuse/SKILL.md`. After installing a local checkout's dependencies with the [source-install procedure](../../README.md#cli-and-mcp), load it with `pi install /absolute/path/to/macuse`. Pi registers that local path without installing or changing its dependencies; the checkout owner maintains them.

Pi's `/reload` replaces extension code and disposes macuse's owned session; Pi's native rules decide which tools stay selected (official Pi 1.5.0 re-activates default-active extension tools on reload, while `fitchmultz/pi` preserves live deselections). Tools newly added to `defaultTools` are enabled on reload. Quit Pi and start a new process after dependency/native-runtime updates, or on older hosts whose code reload is unqualified. Restart CLI/MCP processes after changes too; a new process picks up native helper source changes through the source-hash cache.

Pi starts with three entry tools: `macuse`, `macuse_insert_text`, and `macuse_reset`. The eight recording/history tools register with native `deferred` exposure: `tool_search` loads them, `codemode` calls them, and `defaultTools` or an explicit host tool policy can select them. Pi's declared selection survives resume, fork and compaction without keeping native runtime bindings alive. No host patches or image-sizing settings edits are required for Astra.

See [tool selection](usage.md#tool-selection) for the native selection rules.

## SDK tool selection

When replacing a saved tool selection through the Pi SDK, apply the final selection after extension binding:

```ts
const selected = ["macuse", "computer_history_status"];
const { session } = await createAgentSession({ ...options, tools: selected });
await session.bindExtensions(bindings);
session.setActiveToolsByName(selected);
```

Use `[]` to deliberately deselect all tools. This shared public method cannot enable tools excluded by the host. SDK sessions that pass a plain `tools` allowlist or `noTools` own their initial selection: Pi restores a transcript loadout at session start only for default-tool sessions, and a `tools` list made only of `+name`/`-name` entries modifies that default selection instead of replacing it. Tree navigation restores the branch loadout in every session. Reapply an explicit replacement after resume, fork, or tree operations when the SDK session must keep it. macuse performs no selection restoration of its own.

## Installed paths

Default paths are resolved from the local installation rather than copied versioned caches:

| Component                      | Default location                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| ChatGPT resources              | `/Applications/ChatGPT.app/Contents/Resources`                                                                       |
| Native runtime launch manifest | `/Applications/ChatGPT.app/Contents/Resources/cua_node/manifest.json`                                                |
| Vendor Node packages           | The manifest's `node_modules` directory, containing `@oai/cua-repl` and `@oai/sky`                                   |
| Computer Use service           | `$CODEX_HOME/computer-use/Codex Computer Use.app`                                                                    |
| Codex package descriptor       | ChatGPT resources under `codex-cli/codex-package.json` (layout version 1)                                            |
| Codex executable               | The descriptor's package-relative `entrypoint`; older installations without a descriptor use resources under `codex` |
| Auxiliary plugin roots         | ChatGPT resources under `plugins/openai-bundled/plugins/record-and-replay` and `computer-history`                    |

Both the sandboxed primary runtime and the auxiliary app-server resolve the selected installation's Codex executable. A present package descriptor takes precedence over the legacy path. Invalid descriptors, unsupported layouts, escaping entrypoints, and missing/non-executable targets fail before launch; macuse never silently selects a stale legacy binary or searches `PATH`. Auxiliary resolution stays lazy, so unavailable optional recording/history software does not prevent loading the extension or reading session status. Until that runtime starts, its status reports `codexBin:null` unless an explicit override was supplied.

`CODEX_HOME` retains its existing scope, normally `~/.codex`. `MACUSE_CHATGPT_RESOURCES` selects resources for both runtimes; `CODEX_BIN` can override the auxiliary app-server executable. MCP's `MACUSE_CWD` selects its session working directory. Do not point these at untrusted code or discard authentication context to make a probe pass.

## Permission troubleshooting

A terminal, Pi host, and MCP client can have different responsible-launcher grants. Successful app enumeration or protocol discovery does not prove permission to read/control a particular app. Native AX access and vendor app approval are also separate checks.

For AppleEvents errors such as `-609`, `-1712`, or `-1743`, inspect the responsible launcher and Automation/TCC evidence before concluding the runtime is down. Use the normal system/vendor permission flow. Do not edit TCC databases or disable privacy controls as a shortcut. A locked console or missing window is a separate condition; ask the user to unlock or open the intended app when necessary.

```bash
node tools/macuse-doctor.mjs --out .scratch/doctor
```

Doctor is read-only unless `--full` is explicitly requested. Its results describe the current launcher, not all hosts. See [validation and diagnostics](demo-and-doctor.md) and [dated investigation notes](codex-computer-use-external-harness.md#historical-findings).
