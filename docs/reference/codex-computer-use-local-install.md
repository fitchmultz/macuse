# Local requirements and installation

macuse v0.5.1 is an experimental GitHub prerelease installed in Pi from Git, not npm. Its `private: true` package metadata prevents npm publication. It reuses proprietary software already installed with ChatGPT; external-host use is unsupported and interfaces can change with vendor updates.

## Requirements

- macOS with ChatGPT and its Computer Use installation configured through the vendor's normal setup.
- Access to the installed `@oai/cua-repl`, bundled Node/kernel, and native Sky service.
- Existing vendor authentication and the macOS permissions required by the responsible launcher, including applicable Screen Recording, Accessibility, and Automation grants.
- An installed Swift compiler (`xcrun swiftc`) for macuse's native AX helper. The helper compiles lazily, caches by source hash under `~/Library/Caches/macuse/native`, and needs Accessibility access for focus/window/text operations.
- For Pi, latest stable official Pi or the maintained `fitchmultz/pi`. The development baseline is 0.99.2; macuse uses shared public extension APIs and Pi runtime dependencies come from the host.
- For CLI/MCP, Node 24.21.0 or later and installed repository dependencies.

macuse does not install the vendor runtime/compiler, change user settings, grant permissions, or bypass authentication. Missing requirements should produce a concrete setup error, not a fallback input system.

## Install in Pi

```bash
pi install git:github.com/fitchmultz/macuse@v0.5.1
```

The package supplies `extensions/macuse.ts` and `skills/macuse/SKILL.md`. A local checkout can instead be installed with `pi install /absolute/path/to/macuse`.

Official Pi 0.99.2 and the qualified fork's `/reload` replace extension code, dispose macuse's owned session, and preserve the live permitted tool selection. On hosts supporting it, tools newly added to `defaultTools` are enabled; unchanged defaults do not resurrect tools you deselected. Quit Pi and start a new process after dependency/native-runtime updates, or on older hosts whose code reload is unqualified. Restart CLI/MCP processes after changes too; a new process picks up native helper source changes through the source-hash cache.

For a source-only upgrade from a pre-initialization-marker version, use a new process if no macuse tool declaration has been recorded yet. An entirely deselected legacy session without such a declaration is indistinguishable from first installation; its old reload path also reactivated the primary tools. After initialization by the current version, reload preserves even undeclared live deselections.

Ordinary Pi starts with four tools: `macuse`, `macuse_insert_text`, `macuse_reset`, and `macuse_tools`. Discovery-capable hosts can defer this source-owned `macos` group; official Pi ignores the optional metadata. No `toolDiscovery` settings inventory is required. The eight recording/history tools remain lazy until selected through the loader or an explicit host tool policy. Pi's declared selection survives reload/resume, fork and compaction without keeping native runtime bindings alive. No host patches or image-sizing settings edits are required for Astra.

## SDK tool selection

When replacing a saved tool selection through the Pi SDK, apply the final selection after extension binding:

```ts
const selected = ['macuse', 'computer_history_status'];
const { session } = await createAgentSession({ ...options, tools: selected });
await session.bindExtensions(bindings);
session.setActiveToolsByName(selected);
```

Use `[]` to deliberately deselect all tools. This shared public method cannot enable tools excluded by the host. Reapply an explicit replacement after resume, fork, or tree operations that restore saved declarations, or let declared selections recover normally. Reload preserves the live selection, including changes not yet declared to the model.

**Known limitation:** on the qualified official Pi 0.99.2 baseline, the extension cannot distinguish an SDK `tools` allowlist from equivalent `excludeTools` through the public filtered catalog and active tool list. Supplying only `tools` before binding on resume can therefore lose newly selected tools when an older declaration exists. macuse conservatively restores permitted saved selections rather than resurrecting deselected tools for exclusion-only resumes. The post-bind call above is required for portable explicit replacement; CLI `--tools` already takes precedence.

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
