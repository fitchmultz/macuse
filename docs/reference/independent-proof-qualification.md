# Independent core through public transports

This is an opt-in research qualification, not a production backend migration. The normal macuse extension, CLI, MCP server, recording, and history retain their existing vendor boundaries.

`tools/qualify-independent-proof.mjs` exercises the independent JavaScriptCore executor, guarded session, and native AX/screenshot helper together through four real entry paths:

- persistent CLI JSONL;
- MCP stdio using the public SDK;
- a fresh selected official Pi SDK session;
- a fresh selected `fitchmultz/pi` SDK session.

The Pi workers script model responses, never tool or native results. The real extension, session, executor, native helper, and owned AppKit application produce the results. The workers use in-memory credentials/settings and block fetch; they do not edit the current Pi profile.

## Run

Use trusted, reviewed artifact and Pi package directories. `--package-root` must contain the complete independent executor/session/transports/native/fixture cohort. The runner hashes those inputs before and after the run; it does not supply missing implementation files or substitute mocked native results.

```bash
node tools/qualify-independent-proof.mjs --help
node tools/qualify-independent-proof.mjs \
  --live \
  --package-root /absolute/path/to/complete/macuse \
  --official-pi /absolute/path/to/official/pi-coding-agent \
  --fork-pi /absolute/path/to/exact/fork/pi-coding-agent \
  > independent-proof-report.json
```

`npm run check:compat` smoke-checks only the help entrypoint. Without `--live`, the command does not access the desktop. A live run requires the installed Swift compiler and the responsible launcher's normal Accessibility/screenshot permissions. It creates one disposable, uniquely identified fixture per transport and may bring those windows forward. It changes only observed fixture radio controls and complete test fields. It neither targets user applications/documents nor starts recording/history.

Run it with exclusive desktop-test ownership. Do not change the selected source cohort while it runs. Package directory labels are not provenance verification: retain the actual official package and exact fork-release identities used for the run.

## Gates

Each transport must pass all of these, including cleanup:

1. Capture the fixture's actual original radio selection, both original field values, and native process/window identity through a separate observer.
2. Refuse the wrong app and missing parent mutation flags without a native effect.
3. Deliver two actual PNG payloads with matching content indexes, byte counts, hashes, dimensions, and window/pixel metadata; retain them when a third screenshot is refused by the per-run count budget.
4. Report AXPress as accepted but unverified, then independently observe the selected radio.
5. Set and independently read back an exact Unicode whole-field value.
6. Observe and hash actual owned JavaScriptCore/native worker executables, not guest-supplied process claims.
7. Interrupt a real busy loop at its deadline and verify the sampled generation has exited before any recovery/reset can mask a failed stop. Confirm the UI effect is unchanged by this pure-JavaScript interruption.
8. Reset actual retained bindings and invalidate a real pre-reset observation/token.
9. Exercise a real accessibility setter that changes both its field and sibling radio context. Require attempted/unknown evidence despite successful field readback, immediate worker drainage, refusal of further mutations, and preservation of the prior unknown outcome across reset.
10. Restore both original fields and original radio through the public transport. Refuse to overwrite any field value other than its captured original or the planned fixture replacement.
11. Require final public reset settlement with no pending host calls, verify sampled worker exits, and close the actual transport without unexpected stderr. The CLI's sticky exit 1 is expected after deliberately refused calls, not evidence of successful GUI actions.
12. Independently verify the final original state and stop the owned observer and fixture.

The report has thirteen named checks per transport because original capture, worker inspection, public cleanup/settlement, and final fixture cleanup are recorded separately. A lost acknowledgement, failed readback, unexpected field value, failed restoration, or worker leak fails qualification. Failure cleanup uses fresh bounded observations to restore captured originals, never replaying an attempted replacement.

## Observed result, 2026-10-24

The complete staged source cohort passed all 52 named checks across CLI, MCP, official Pi 1.4.0, and the immutable `ab6cedbb72d46a8205a194c727413197468ff4fe-a1ed00d80dfd07ad-node24.22.1-darwin-arm64` fork Pi 1.4.0 release. This was Node 24.22.1 on macOS 27.0.1, arm64, build 26A434. Input source hashes were unchanged throughout the run.

Key source identities:

| Input | SHA-256 |
| --- | --- |
| Qualification runner | `81fb5b53524133cf8db78988a2469442c381b8d271dc3a8bf87165025b20f50a` |
| Independent session | `0c508cd6d325561e455aaebff5f8dc4fc602b602d778682cbd7d9c189c5c413e` |
| Native parent wrapper | `89770465f82d6ad9e25edcfeef92900e9da74de3753ec0dade84cc24b10bb218` |

Each transport delivered two 43,856-byte PNGs at 960×504 pixels, with a 480×252-point fixture window and scale 2. The original selection was observed as Energy, not assumed. Both original fields and Energy were verified restored. The actual context-changing setter remained an unknown effect in the evidence even after inspection/reset. Final settlement had zero pending host calls; sampled helpers/transports and all four fixtures exited. No unexpected stderr was present. No screenshot bytes are published here.

The Pi image proof is exact bytes in the real stored tool-result channel. It does **not** certify subsequent provider/network request bytes. Auto-resize was disabled only in the isolated qualification profiles; current user settings were not changed.

This result is tied to the recorded source cohort and host paths/manifests, not blanket qualification of subsequent commits, dependency updates, reloads, or arbitrary package directories. The run's full metadata belongs in its delivery evidence.

## Deliberate limits

`fullIndependenceQualified` remains **false**, even when the fixture report's `ok` is true. This proves a useful independent core for a controlled fixture, not complete macuse parity.

Still unattempted by this gate:

- general-app and Activity Monitor compatibility;
- selected-range insertion;
- visual correctness of screenshot content and pointer-coordinate actions;
- keyboard, pointer, focus, and broader app-transition coverage;
- independent Record & Replay and Computer History;
- independent pinning/distribution of Apple's system JavaScriptCore;
- signed production helper deployment and default-backend migration.

The earlier native Activity Monitor attempt exceeded the full-snapshot bound before any action. A successful fixture run does not erase that failure or justify weakening the bound. Resets and process exits do not undo or prove cancellation of GUI effects.
