# Writing tests

A test earns its place when it fails for a bug a user or caller would notice. Every test also costs CI time on every pull request, so a test that cannot fail is pure cost. [ADR 0017](../../adr/0017-separate-maintained-tests-from-disposable-verification.md) decides where tests live. This page covers what makes one worth keeping.

## Assert behavior

Call the code the way its users do, then assert the result against a literal expected value. Before you write an assertion, name the bug it would catch. If you cannot name one, do not write the test.

A quick check: if the test would still pass when every imported function returned `undefined`, it tests nothing.

## Patterns that do not test behavior

- **Source text.** Reading a `.ts`, `.tsx`, or `.css` file and matching it with a regex. It breaks on refactors and passes on runtime bugs. Lint rejects it.
- **Class names.** Asserting that an element has a Tailwind class. Assert the state the class expresses instead, such as a role, an `aria-*` attribute, or visible text. Leave layout to live verification.
- **Mock echo.** Asserting that a mock received the arguments the test just passed through. Assert what the code did with the mock's answer.
- **Set then read.** Setting store state and reading the same value back. Test the action or selector that derives something from the state.
- **Restated constants.** Asserting that a constant, schema default, or type equals its own definition.
- **jsdom geometry.** jsdom does no layout, so `scrollWidth`, `clientWidth`, and `getBoundingClientRect` are always zero. Assertions on them always pass.

## Keep tests cheap

The web suite pays about 0.65 s of environment setup and imports per file before any test runs, and more than half of its files have under 50 ms of test body. In the server suite, a new database writer worker costs about 250 ms, almost all of it spent loading the writer's modules. That was most of each test in the slowest server files.

- **No real sleeps.** Use `vi.useFakeTimers()` and `vi.advanceTimersByTimeAsync`, or `vi.waitFor` for a condition. Lint rejects awaited `setTimeout` sleeps in web tests. Server tests that drive real processes, sockets, or file watchers may still wait on the clock.
- **Inject production delays.** When code under test waits on purpose, as `CleanupWorker` does for Windows file handles, let the test pass a zero delay instead of paying it.
- **Extend the unit's existing test file.** Do not start a new file for one more case.
- **Use the node environment unless the test needs a DOM.** Web `*.test.ts` files run in node. Add `// @vitest-environment jsdom` at the top of a `.ts` test only when it touches `window` or `document`.
- **Use the shared database fixtures.** They copy a migrated template database instead of re-running migrations, and they reuse a cleanly closed writer worker through `leaseWriterWorker`. A test that builds its own `ApplicationDatabaseWriter` should pass `leaseWriterWorker` too, unless it kills or replaces workers, as the writer lifecycle tests do.
