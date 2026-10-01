# Pi 1.0 modernization and qualification

## Supported behavior

Pi 1.0.0 is the supported floor. The native persistent Computer Use runtime, guarded actions, focus observations, selected-text insertion, screenshot ownership, recording/history privacy gates, and enable-first auxiliary loadout remain unchanged. Native codemode composes these tools; it does not replace their persistent runtime. The kept synchronous `pi:instruction-groups` collector remains optional; official Pi receives the complete `macos` prompt section.

Astra original-image restoration now checks model/API eligibility before touching history. The first eligible context seeds one retained-window raw result index. Finalized message events feed it; the next eligible request reconciles appended entries after host persistence, including post-handler compaction drafts. Supplied request messages select candidates, and exact wire text/image fields, order, detail, and image bytes must still match. Branch/resume/reload/compaction reseed or invalidate. Reused wire call IDs fail closed. Filtering and context edits cannot become a new restoration baseline.

Only image bytes actually resized by Pi are retained separately, once. Unchanged images remain in normal content; capped full-output details contain complete text without duplicating images. Existing saved `originalContent` results remain readable. No image sidecar, second tool-selection journal, deferred callability change, or private structured-details exposure was introduced.

## Checked 2026-10-01

- Canonical macuse base: `6a4769f4f1f15d8e847ec092c25e86675d725620`.
- Official source: `a13d35a742c6ef8462812a28fbe1d8c8b7431c32` (v1.0.0). SDK SHA256: `5482298b995db935f7b96f5d6056fa1c36ac6fc80456be594ef65b83c62b0d30`; bundled CLI: `e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774`.
- Node 24.21.0; all eight host companions 1.0.0; TypeBox 1.3.27. Validation uses an empty HOME/agent profile, physical Node, and explicit selected `PI_PACKAGE_DIR`, never the inherited live-fork override.
- `PI_OFFLINE=1 npm run check:compat`: 173 tests passed, zero failures/skips; typecheck, offline extension contract, actual native SDK/image-normalizer/Responses adapters and dry-run package passed.
- Handler regression: 20 non-target requests performed zero history reads/projections; 20 warm Astra requests performed zero additional reads/projections in a 43,001-entry fixture. A normal appended message required one indexed entry read, not a full projection. Filters, edits, reused IDs and post-handler compaction were checked.
- `node tools/validate-pi-host.mjs HOST [PACKED_PACKAGE]`: source and packed package passed actual oversized-image normalization, single-copy serialization, both Responses APIs, strict schema, persisted context edit, branch/resume byte restoration and retain-none compaction (10 local mocked HTTP requests; no provider/network calls).
- `node .github/scripts/validate-pi-cli.mjs HOST [PACKED_PACKAGE]`: source and packed package loaded in the actual official bundled CLI; observer reported selected official package path/version and the four intended active tools. Ordinary ESM import also passed without Jiti aliases.
- Isolated fullscreen and regular CLI fixture: narrow 48, normal 100 and wide 160 columns plus resizing inspected. Native default tool renderer showed Unicode, partial-failure text and image fallback without clipping or replay. Fixture host observers reported exact official 1.0.0; no user application or native GUI action was dispatched. Terminal fallback, not inline-image terminal support, was inspected.

Local inspectable logs: `/tmp/macuse-pi100-final-{check,sdk,cli}.log`, `/tmp/macuse-pi100-packed-{sdk,cli}.log`, `/tmp/macuse-pi100-esm.log`. UI fixture and six captures: `/tmp/pi100-native-services/macuse-{fullscreen,regular}-{48,100,160}.txt`; identity observations alongside them. All owned tmux sessions and native test processes were cleaned up.

## Delivery and remaining qualification

Recommended non-reused release: **0.6.0**, Git/GitHub experimental prerelease plus checked tarball only. `private: true` remains; no npm publication channel is added. Existing older unreleased native changes on canonical main are preserved.

The live 0.99.1 fork and managed packages/settings/auth were untouched. The future minimal 1.0 fork has no qualified immutable candidate yet; these official checks are not a fork pass. Parent owns independent review, merge and historical release. No merge, tag, publication, install, activation, reload or restart of live sessions occurred.

`npm run ci` includes the live-desktop `quick` gate and was not run under the no-user-app-actions constraint. No paid/provider acceptance, live native GUI mutation/focus, recording, privacy change or vendor-auth flow was attempted. The prior GitHub prerelease's discovery/recovery delivery used offline/native lifecycle checks without requiring desktop/recording actions; this change does not alter those OS action implementations. Live operational diagnostics remain separately scoped, not silently marked passing.
