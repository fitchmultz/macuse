# Engineering standard records

Records for the adoption of [engineering-standard.md](engineering-standard.md) (Strict Oxlint and Oxfmt Engineering Standard v5.1.2). Quality exceptions follow the standard's Section 2 and Appendix B.

## Adoption record

| Field                   | Value                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository              | `fitchmultz/macuse`                                                                                                                                                                                                                                                                                                                                                           |
| Adopted standard        | v5.1.2, copied at `docs/reference/engineering-standard.md` (sha256 `41b6d505b36007218ca56b7b3443fcbd96d994715da5a83aaca52b58af47d3d6`; formatter-clean under the adopted oxfmt config)                                                                                                                                                                                        |
| Supported runtimes      | Node.js 24.22.3 or newer in 24.x, or 26.13.1 or newer; native macOS hosts for desktop checks                                                                                                                                                                                                                                                                                  |
| Package manager         | npm (`npm@12.2.1`), committed lockfile                                                                                                                                                                                                                                                                                                                                        |
| Toolchain               | oxlint `1.90.0`, oxfmt `0.75.0`, oxlint-tsgolint `7.0.2005`, TypeScript `7.0.2` (devDependencies, exact)                                                                                                                                                                                                                                                                      |
| Lint configuration      | `.oxlintrc.json` (Appendix A baseline; `ignorePatterns`: `node_modules`, `.scratch`, `subagent-output`)                                                                                                                                                                                                                                                                       |
| Formatter configuration | `.oxfmtrc.json` (Section 7.1 defaults; `sortPackageJson` and other sorting disabled)                                                                                                                                                                                                                                                                                          |
| Formatter ownership     | oxfmt owns maintained `.mjs`, `.d.mts`, `.ts`, `.json`, `.md`, and `.yml` files. `package-lock.json` is generated output owned by npm. Swift sources (`.swift`) and vendored bytes have no oxfmt owner.                                                                                                                                                                       |
| Compiler projects       | root `tsconfig.json` compiles `extensions/**/*.ts`, `.github/scripts/**`, and all maintained JavaScript (`lib/**/*.mjs`, `tools/**/*.mjs`) with `allowJs`/`checkJs` and the Section 4.2 strict-family options; `.d.mts` declarations are checked by `tsconfig.declarations.json` with `skipLibCheck` off. Both projects run in `npm run typecheck` and pass with zero errors. |
| Source profiles         | Production: `lib/`, `extensions/`, `tools/*.mjs` (bin + qualification tooling), `.github/scripts/`. Tests: `tools/tests/*.test.mjs`. Handwritten declarations: `lib/*.d.mts`, `tools/*.d.mts`. Static fixture app: `tools/actuator-fixture.mjs` (implementation-owned). No maintained React/Vitest/Jest sources; test runner is `node:test`.                                  |
| Acceptance commands     | `npm run check:compat` (canonical aggregate), `npm run ci`, `npm run format:check`, `npm run lint`                                                                                                                                                                                                                                                                            |
| Hosted CI               | `.github/workflows/ci.yml` (Linux contracts + macOS native hosts) and `.github/workflows/pi-compatibility.yml`                                                                                                                                                                                                                                                                |
| Migration status        | See "Migration status" below                                                                                                                                                                                                                                                                                                                                                  |

### Migration status

Phased adoption per standard Section 9.2. Enforcement is added in each phase only for scope that passes its complete declared checks:

1. Toolchain, configurations, formatting ownership, and `format:check` gating — complete.
2. Compiler coverage expansion (`allowJs`/`checkJs` and Section 4.2 options over all maintained JavaScript) with source repairs until `npm run typecheck` passes — complete.
3. Strict lint enforcement (`npm run lint` and `lint:agent` in `check:compat`/`ci`) covers all maintained source. The qualification controls and integrity checks cover the declared profiles and exceptions.

No finding budgets, diagnostic filtering, or incomplete-source exemptions are in force. Adoption also requires passing hosted CI on the integrated revision.

### Verification

`npm run check:compat` runs each independent gate and reports all failures. The aggregate includes native lint, agent-format lint, both compiler projects, tests, formatting, npm lockfile freshness, policy and coverage, offline extension and Pi host contracts, and package checks.

`npm run qualify:engineering` copies the current tracked and untracked inputs into a temporary workspace. It records the base revision and input digest, runs the Section 8.2 controls, and removes the workspace. The controls exercise actual lint diagnostics and compiler projects, the Node registration allowance, directive and policy integrity, formatting and generated freshness, and failure propagation through the complete acceptance command. The qualification fails if its working-tree inputs change while it runs.

The qualification does not establish live desktop, recording, authentication, or provider behavior. Hosted CI separately checks the supported official and fork Pi hosts.

## Quality-exception record

The exact authorized sites are listed in `configs/engineering-directive-sites.json`. The policy checker parses source comments and compares the rule, operation, enclosing test or method, and branch to that inventory. Oxlint reports unused directives. The identifiers below are stable; unused identifiers are not reused.

### QX-002: Low-level MCP server

- **Finding and scope:** oxlint 1.90.0 and oxlint-tsgolint 7.0.2005 report `typescript/no-deprecated` on `new Server` in `tools/macuse-mcp.mjs` and `tools/independent-proof-mcp.mjs`.
- **Contract and comparison:** both servers expose the JSON Schemas already owned by `lib/tools.mjs` and `lib/independent-proof-tools.mjs`. SDK 1.32.1 reserves `Server` for advanced use (`server/index.d.ts:71`). Its `McpServer.registerTool` accepts Zod schemas (`server/mcp.d.ts:161-168`) and `server/mcp.js:905-915` rejects an unrecognized object. Replacing these calls with `registerTool` therefore requires a second schema representation and can change validation or the published schema. The high-level API does support result `_meta`; that is not a reason for this exception.
- **Adjustment and evidence:** two operation-bound directives preserve the single schema owner. MCP transport tests exercise tool discovery, results, and evidence; the normal lint gate retains deprecation checks elsewhere. Detection of deprecation at these two constructors is lost. Revisit on an SDK upgrade or a native high-level JSON Schema registration API.

### QX-003: MCP protocol close callback

- **Finding and scope:** `unicorn/prefer-add-event-listener` reports the two `server.onclose` assignments in the MCP entrypoints. SDK 1.32.1 declares `Protocol.onclose` as a callback property (`shared/protocol.d.ts:251`), not an EventTarget.
- **Comparison and adjustment:** `server.addEventListener("close", ...)` is not supported by the installed API. The two specific assignments retain SDK-managed shutdown and are separately inventoried. The rule remains active elsewhere; detection at these assignments is lost. MCP transport tests and the typecheck exercise the actual API. Revisit if the SDK adds an event-listener API.

### QX-006: Deliberately invalid test inputs

- **Finding and scope:** `typescript/no-unsafe-type-assertion` reports the four inventoried casts in `tools/tests/auxiliary-runtime.test.mjs`, `independent-proof-session.test.mjs`, and `macuse-session.test.mjs`. Each cast creates an intentionally invalid value for a runtime rejection or snapshot-isolation test.
- **Contract and comparison:** the production declarations describe valid callers, but JavaScript and transport input can violate those types. A valid typed value cannot exercise the negative cases; widening production contracts solely for tests would misrepresent their public types. For example, a JSON array passed as `macuse` tool input must be refused by session validation before any native access. The casts make no claim that these values are valid and do not enter trusted production code.
- **Adjustment and evidence:** each operation has its own directive and selector. Existing tests assert rejection, no dispatch, or an unchanged snapshot. This loses the unsafe-assertion diagnostic only at those operations; the rule remains active for other assertions. Revisit when a public input boundary honestly accepts `unknown` or its test is removed.

### QX-007: Partial Pi command contexts in tests

- **Finding and scope:** `typescript/no-unsafe-type-assertion` reports the two inventoried `ExtensionCommandContext` test fixtures in `tools/tests/pi-lifecycle.test.mjs`.
- **Contract and comparison:** these direct status-command tests supply `hasUI` and `ui.notify`, the fields read by the status handler in `extensions/macuse.ts`. A complete context contains the Pi session, UI, and command lifecycle (`@earendil-works/pi-coding-agent` extension types), which cannot be represented by this small fake. Building a second simulated Pi host would add behavior unrelated to these status assertions; the same suite separately exercises actual SDK session boundaries.
- **Adjustment and evidence:** the two direct handler calls alone use operation-bound casts. The handler's field use and the real-host tests are the soundness boundary, not the assertion itself. Other unsafe assertions remain errors. Revisit if the handler reads more context fields or the tests switch to a real command context.

### QX-008: Node test registration promises

- **Finding and scope:** `typescript/no-floating-promises` reports an unawaited `node:test` registration. Node owns registration scheduling; awaiting every top-level call changes module evaluation and is prohibited by the adopted standard. All actual registrations use the imported local name `nodeTest`; the allowance applies only to the test profile and the installed `node:test` declaration origin.
- **Comparison and adjustment:** awaiting registrations serializes module evaluation. Per-call suppressions would require a directive on every registration and obscure the tests. The test-profile `allowForKnownSafeCalls` entry retains `checkThenables: true`, `ignoreVoid: false`, and all other options. Actual top-level registrations are unawaited, matching the pre-migration tests.
- **Verification and limit:** qualification checks cover default and named imports, a suite-body registration, unawaited context subtests, same-named local and other-module functions, and floating work inside and outside tests. An imported `nodeTest` invoked inside a running test also matches the declaration allowance. Use `t.test()` for subtests; the policy checker rejects a registration syntactically nested in another registration. The lint rule cannot prove all runtime calling contexts. Revisit when Node declarations, Oxlint origin matching, or registration forms change.

The policy and qualification checks protect the listed sites and neighboring violations. Engineering review must also assess each rationale; the inventory cannot prove its own justification.
