# Devin CLI Discovery Roots — Skills, Commands, Plugins, Subagents, Rules

**Status:** Research only — no implementation changes.
**Devin CLI observed:** `devin 3000.10.21 (611c1cba)` at `C:\Users\cjnwo\AppData\Local\devin\cli\bin\devin.exe` (standalone CLI install; the Devin Desktop app also bundles a copy plus the full docs tree under `C:\Users\cjnwo\AppData\Local\Programs\Devin\resources\app\extensions\windsurf\devin\share\devin\docs\`).
**Evidence tags:** `[verified]` = observed on this machine via `devin` list/paths/doctor commands, a controlled probe project, or filesystem inspection. `[doc]` = stated in Devin's bundled `.mdx` docs. `[inferred]` = reasoned from adjacent evidence. `[unknown]` = could not verify.

---

## 1. How Devin Models the Surfaces

Devin has one unified discovery model (`devin --help`, v3000.10.21):

* **Skills** are both slash commands and agent-invocable context blobs (`devin skills` — "slash commands and agent-triggered context blobs"). There is no separate `.devin/commands/` directory; user-invocable commands are skills with the `user` trigger.
* **Rules** are always-on or trigger-activated context blobs (`devin rules`).
* **Custom subagents** are markdown profiles under `agents/` directories.
* **Plugins** are installable bundles (skills + rules + hooks + MCP + subagents) governed by a manifest and four authority levels.
* **Hooks** are lifecycle JSON config (`.devin/hooks.v1.json` etc.), not user-invocable.
* Cross-tool compatibility is implemented as a `config-importers` crate inside the binary (importers: `claude`, `cognition`, `cursor`, `windsurf`, `copilot`, `zed`, `opencode`, `mcp`, `config` — binary strings `config-importers/src/importers/<name>/`), gated by `read_config_from` config keys `[doc]` `agents_standard`, `cursor`, `windsurf`, `claude`, `copilot`, `opencode`, `zed` (all default `true`).

`devin skills list --json` emits per-skill fields: `name`, `description`, `triggers` (`["user","model"]` subsets), `provider` (`Builtin` | `Devin` | `Cursor` | `Copilot`), `base_dir`, `display_name`, `warnings`, `errors` `[verified]`.

---

## 2. Skill Scan Roots

`devin skills paths` prints only the *native* roots `[verified]`:

```
User skills (global):
  %APPDATA%\devin\skills\<skill-name>\SKILL.md
  %APPDATA%\cognition\skills\<skill-name>\SKILL.md
  ~\.agents\skills\<skill-name>\SKILL.md
Project skills:
  .devin\skills\<skill-name>\SKILL.md
  .cognition\skills\<skill-name>\SKILL.md
  .agents\skills\<skill-name>\SKILL.md
```

But `devin skills list` discovers far more. On this machine: 261 skills — 86 from `~/.cursor/skills`, 69 from `~/.agents/skills`, 65 from `~/.claude/skills`, 36 from `~/.copilot/skills`, 3 from `<project>/.agents/skills`, 2 Builtin `[verified]`.

A controlled probe project (`%TEMP%\devin-probe` with one `SKILL.md` per candidate dir) confirmed project-level roots empirically `[verified]`:

| Project dir | Discovered? | `provider` field |
|---|---|---|
| `.devin/skills/<name>/SKILL.md` | Yes | `Devin` |
| `.cognition/skills/<name>/SKILL.md` | Yes | `Devin` |
| `.agents/skills/<name>/SKILL.md` | Yes | `Devin` |
| `.windsurf/skills/<name>/SKILL.md` | Yes | `Devin` |
| `.claude/skills/<name>/SKILL.md` | Yes | `Devin` |
| `.cursor/skills/<name>/SKILL.md` | Yes | `Cursor` |
| `.github/skills/<name>/SKILL.md` | Yes | `Copilot` |
| `.copilot/skills/<name>/SKILL.md` | **No** | — |
| `.devin/commands/*.md`, `.agents/commands/*.md`, `.claude/commands/*.md` | **No** | — |

User-level roots beyond `skills paths` (all `[verified]` via `skills list` base_dirs): `~/.claude/skills/**/SKILL.md`, `~/.cursor/skills/`, `~/.copilot/skills/` (or `$COPILOT_HOME/skills/` `[doc]`), `~/.codeium/<channel>/skills/` where `<channel>` ∈ `windsurf`/`windsurf-next`/`windsurf-insiders` `[doc]` (`~/.codeium/windsurf/` exists here; no `skills/` subdir yet). Docs also state `.claude/skills` and `.copilot` skills are globbed recursively (`**/SKILL.md`) `[doc]`.

**Key asymmetry:** Copilot's *project* skills dir is `.github/skills/`, not `.copilot/skills/` `[doc]` `[verified]`. `.copilot/` is user-level only.

**Naming/collision rules** `[verified]` (probe with same-named skills across roots):

* Unique name → bare `/name`.
* Collision *across importer groups* → **all** surviving copies get `<importer>:` prefixes (`devin:`, `agents:`, `windsurf:`, `claude:`, `cursor:`, `copilot:`, `github:` observed; `cognition:` `[inferred]`).
* Within the native Devin chain the precedence is **`.devin` > `.cognition` > `.agents`** — the winner takes the name (bare if no cross-group collision), lower-priority copies are **shadowed entirely** (no prefixed fallback). Verified: `.devin`+`.agents`+`.cognition` clash → only the `.devin` copy appears.
* Installed plugin skills appear as `/<plugin>:<skill>` `[doc]`.

`.claude/commands/**/*.md` is documented as imported "as skills" `[doc]`, but probe files (flat, nested, with and without frontmatter) did **not** appear in `devin skills list` `[verified-negative at project level]`; `~/.claude/commands/` does not exist on this machine so user-level import is `[unknown]`. Devin has **no** `.devin/commands/` or `.agents/commands/` surface `[verified]`.

`SKILL.md` frontmatter fields `[doc]`: `name`, `description`, `argument-hint`, `model`, `subagent` (bool), `agent` (profile), `allowed-tools`, `permissions`, `triggers` (`user`, `model`; default both).

---

## 3. Custom Subagent (agents) Roots

`devin doctor` prints `custom subagent profiles  N profile(s) loaded: <names>` `[verified]`. Probe results:

| Root | Discovered? |
|---|---|
| `.devin/agents/<name>.md` | Yes `[verified]` |
| `.devin/agents/<name>/AGENT.md` | Yes `[verified]` |
| `.agents/agents/<name>.md` | Yes `[verified]` |
| `.cognition/agents/<name>.md` | Yes `[verified]` (undocumented) |
| `.claude/agents/<name>.md` | **No** `[verified-negative]` — also `~/.claude/agents/` (9 real files on this machine) loads **nothing** |
| `%APPDATA%\devin\agents\` (= `~/.config/devin/agents/`) | `[doc]` only |
| Plugin `agents/<name>.md` or `agents/<name>/AGENT.md` | `[doc]` (`<plugin>:<name>`) |

Doc layout: `.devin/agents/` or `.agents/agents/` at project root; `~/.config/devin/agents/` globally. Directory form accepts `AGENT.md` (preferred), then `AGENTS.md`, `agent.md`, `agents.md`; frontmatter `name`, `description`, `model`, `allowed-tools`/`tools`, `max-nesting` `[doc subagents.mdx]`. The bundled `extensibility/index.mdx` claims `.claude/` import covers "custom subagents" — **contradicted by observation** in v3000.10.21; treat `.claude/agents` as not scanned until re-verified in a newer build.

Built-in profiles: `subagent_explore`, `subagent_general` `[doc]`.

---

## 4. Rules Roots

`devin rules list` on this machine shows `AGENTS [Standard]`, `CLAUDE [Claude]`, `global_rules [Windsurf]`, `AGENTS [Standard]` — i.e. project `AGENTS.md`, `%APPDATA%\devin\AGENTS.md`, `~/.claude/CLAUDE.md`, and `~/.codeium/windsurf/memories/global_rules.md` all load `[verified]`. `devin rules paths` lists only `.windsurf/rules/*.md` and `.cursor/rules/*.md` (a subset, like `skills paths`).

| Root | Status |
|---|---|
| `AGENTS.md`, `AGENTS.local.md`, `AGENT.md`, `.windsurfrules`, `CLAUDE.md` at workspace root | `[doc]` + `[verified]` (always-on; subdirectory files load lazily when the agent touches that dir) |
| `%APPDATA%\devin\AGENTS.md` / `~/.config/devin/AGENTS.md` (+ `AGENT.md`) | `[verified]` + `[doc]` |
| `~/.claude/CLAUDE.md` | `[verified]` + `[doc]` |
| `.devin/rules/*.md`, `.devin/global_rules.md` | `[verified]` (probe: `drule [Devin] always-on`, `global_rules [Devin]`) |
| `~/.devin/rules/*.md`, `~/.devin/global_rules.md` | `[doc]` |
| `.windsurf/rules/*.md`, `.windsurf/global_rules.md` | `[verified]` + `[doc]` (`wrule [Windsurf] manual`) |
| `~/.codeium/<channel>/memories/global_rules.md` | `[verified]` (loads as `global_rules [Windsurf]`; binary string `Imported Windsurf global_rules.md`) |
| `.cursor/rules/*.md`, `.cursor/rules/*.mdc` | `[verified]` + `[doc]` (`crule [Cursor] manual`) |
| Plugin `AGENTS.md` + `rules/*.md` | `[doc]` |

Rule activation types: `always-on`, `manual`, `model_decision`/`agent`, `glob` (frontmatter `trigger:` or Cursor's `alwaysApply`/`globs`/`description`) `[doc]` `[verified]`. `read_config_from` config keys gate importers `[doc]`; binary shows the full key enum `agents_standard claude devin cursor windsurf opencode zed copilot builtin`.

Note `~/.devin/` on Windows doubles as the Devin Desktop app-data dir (`argv.json`, `extensions/extensions.json` — Windsurf/VS Code-shaped `[verified]`); the docs' `~/.devin/rules/` and `~/.devin/plans/` coexist inside it.

---

## 5. Plugin System

**Yes, Devin has plugins** (`devin plugins install|list|info|update|remove|prune`) `[verified]` `[doc]`:

* **Sources:** GitHub `owner/repo`, any git URL, local path; `#sub/dir` selects a plugin below repo root. `--local` installs machine-only; default records the plugin in the user's **personal manifest in Devin Cloud** (syncs across machines and into cloud sessions). Requires `devin auth login`.
* **Authority levels** (highest first): **Enterprise** managed manifest → **Org** managed manifest → **Repo** (`requiredPlugins`/`optionalPlugins`/`forbiddenPlugins` in `.devin/config.json`, discovered walking up from cwd) → **User** installs `[doc]`. The CLI fetches managed/personal manifests from Devin Cloud; local proof: `%APPDATA%\devin\cli\plugins\discovered.json` contains `managed` origins keyed by `account_id`, `org_id`, `user_id` (`devin-team$account-…`), plus `%LOCALAPPDATA%\devin\cli\managed_plugins.*.bin` caches `[verified]`.
* **Manifest precedence:** `.devin-plugin/plugin.json` > `.claude-plugin/plugin.json` > root `plugin.json` ([Agent Plugins 1.0.0 spec](https://github.com/agentplugins/agent-plugins-spec)); `.claude-plugin/marketplace.json` also recognized `[doc]` + binary strings.
* **Plugin layout:** `skills/<name>/SKILL.md`, `AGENTS.md`, `rules/*.md`, `agents/<name>.md|AGENT.md`, `hooks.json`, `.mcp.json`, manifest `mcpServers`/`skills` overrides `[doc]`.
* **"Marketplace"** is a *convention*, not a hosted registry: a git repo whose root is a meta-plugin with `plugins/<name>/` subplugins; admins install it at org/enterprise scope via `app.devin.ai/customize` `[doc quickstart.mdx]`.
* **Local store:** `%APPDATA%\devin\cli\plugins\` holds `discovered.json` + `lock.json` `[verified]`; on-disk plugin *content* location `[unknown]` (no plugins installed here — `devin plugins list` → "No plugins installed").
* **No `.devin/plugins/` project dir** `[doc]` + `[verified]` — repo-level plugins are declared in `.devin/config.json` lists, not a folder.

---

## 6. Remote Sources

Discovery is **filesystem + Devin Cloud manifests + ACP notifications** — there is no public browsable skill registry `[inferred]`:

* `https://api.devin.ai` — managed plugin manifests (enterprise/org/user), team settings, model configs, user status; cached as `managed_plugins.*.bin`, `team_settings.*.bin`, `model_configs_v5.*.bin`, `user_status.*.bin`, `unleash_definitions.*.bin` in `%LOCALAPPDATA%\devin\cli\` `[verified]`.
* `https://app.devin.ai/customize` — web UI for plugin install/indexing (`Add plugin → From repository`) `[doc]`.
* `https://static.devin.ai/cli/current/manifest.json` — CLI self-update manifest (binary string).
* Cloud dashboard hooks — binary string `Loaded  hooks from cloud` / `cloud dashboard hooks` (hooks can also be remote).
* Plugin *content* is fetched via git using the user's own git credentials `[doc]`; local-folder plugins are symlink-style live links.

---

## 7. ACP Surface

* `devin acp` **does** emit `available_commands_update` `session/update` notifications — binary contains `available_commands_update`, `AvailableCommandsUpdate`, and log lines `ACP: failed to (re-)send available commands for session` `[verified]`; docs state "the ACP server advertises its full slash-command set" including built-ins (`/login`, `/plan`, `/ask`, `/compact`, `/loop`, `/workspace`, `/add-dir`, `/mcp`, …) grouped in Account/Session/System **categories** `[doc commands.mdx §316–329]`.
* Payload per ACP spec: `{ update: { sessionUpdate: "available_commands_update", availableCommands: [{ name, description, input?: { hint } }] } }`. Devin's `AvailableCommand` also carries `_meta`-style extension fields `cognition.ai/replacementText` and `cognition.ai/icon` (binary `AvailableCommandMeta` struct); "categories" per docs `[verified-strings]`.
* Devin ACP extension methods (binary strings, `agent-ext/src/plugins/`): `plugins/list`, `plugins/install`, `plugins/remove`, `plugins/refresh`, `plugins/assets`, `plugins/review`; notifications `cognition.ai/plugins/changed`, `plugins/activated`, `cognition.ai/mcp/serversChanged`, `cognition.ai/workflows/migrate`; MCP ext ops `listServers`, `listTools`, `connectServer`, `installServer`, `removeServer`, `disconnectServer`, `toggleServer`, `toggleTool`.
* Mcode already tolerates `available_commands_update` in `packages/providers/src/private/devin/devin-acp-event-mapper.ts` (line 54) and the Cursor mapper (line 84).

---

## 8. Discovery Surface → Evidence Table

| Surface | Devin root(s) | Verified? |
|---|---|---|
| Skills — native user | `%APPDATA%\devin\skills`, `%APPDATA%\cognition\skills` (`~/.config/{devin,cognition}/skills`), `~/.agents/skills` | `skills paths` + `skills list` |
| Skills — compat user | `~/.claude/skills/**`, `~/.cursor/skills`, `~/.copilot/skills` (or `$COPILOT_HOME/skills`), `~/.codeium/<channel>/skills` | `skills list` base_dirs (65/86/36 entries) |
| Skills — project | `.devin/skills`, `.cognition/skills`, `.agents/skills`, `.windsurf/skills`, `.claude/skills`, `.cursor/skills`, `.github/skills` | probe project |
| Commands dirs | none native; `.claude/commands/**` doc-claimed, not observed in `skills list` | probe: negative |
| Subagents | `.devin/agents`, `.agents/agents`, `.cognition/agents`, `%APPDATA%\devin\agents`, plugin `agents/`; `.claude/agents` NOT loaded | `devin doctor` probe |
| Rules | `AGENTS*.md`/`AGENT.md`/`CLAUDE.md`/`.windsurfrules`, `.devin/rules`+`global_rules.md`, `.windsurf/rules`+`global_rules.md`, `.cursor/rules`, `~/.devin/rules`+`global_rules.md`, `~/.claude/CLAUDE.md`, `~/.codeium/<channel>/memories/global_rules.md`, `%APPDATA%\devin\AGENTS.md` | `rules list` + probe |
| Hooks | `.devin/hooks.v1.json`, `.devin/config{,.local}.json` `hooks` key, `.claude/settings{,.local}.json`, `~/.claude{,.json}/settings*.json`, `%APPDATA%\devin\config.json`, `.windsurf/hooks.json` (migrate), plugin `hooks.json`, cloud dashboard | docs + binary strings |
| Plugins | install via git/local; manifests `.devin-plugin/plugin.json` > `.claude-plugin/plugin.json` > `plugin.json`; state `%APPDATA%\devin\cli\plugins\{discovered,lock}.json`; managed manifests via `api.devin.ai` | `plugins` help + files |
| MCP | `.devin/mcp_config{,.local}.json`, `%APPDATA%\devin\mcp_config.json`, `.mcp.json`, `.cursor/mcp.json`, `.claude/settings*.json`, `~/.claude*`, `~/.codeium/<channel>/mcp_config.json`, `opencode.json`, `.zed/settings.json`, plugin `.mcp.json`/`mcp.json` | docs + `devin mcp` |
| ACP | `available_commands_update` notification; `plugins/*` ext methods; `cognition.ai/*` notifications | binary strings + docs + ACP spec |

---

## 9. Scan Roots Mcode Should Implement

Mcode's `ScanRoot` model is `{ path, source: "user"|"project"|"agent"|"plugin", providers: string[], kind: "skills"|"commands"|"both", prefix? }` (`apps/server/src/features/agents/skills/catalog/skill-service.ts`, lines 311–363). To give the `devin` provider parity with what `devin` itself discovers:

### User level (`source: "user"`)

| Path (Windows) | Path (macOS/Linux) | kind | providers |
|---|---|---|---|
| `%APPDATA%\devin\skills` | `~/.config/devin/skills` | skills | `["devin"]` |
| `%APPDATA%\devin\agents` | `~/.config/devin/agents` | both* | `["devin"]` |
| `%APPDATA%\cognition\skills` | `~/.config/cognition/skills` | skills | `["devin"]` |
| `~\.agents\skills` | `~/.agents/skills` | skills | `["devin","codex","claude"]` (shared `.agents` standard; currently left to the Codex catalog — see note) |
| `~\.claude\skills` | `~/.claude/skills` | skills | add `"devin"` to existing `["claude"]` |
| `~\.cursor\skills` | `~/.cursor/skills` | skills | add `"devin"` to existing `["cursor"]` |
| `~\.copilot\skills` (+ `$COPILOT_HOME/skills`) | same | skills | add `"devin"` to existing `["copilot"]` |
| `~\.codeium\windsurf{,-next,-insiders}\skills` | `~/.codeium/<channel>/skills` | skills | `["devin"]` |

\* `agents/` dirs need a small scanner extension: flat `<name>.md` (commands-style) **plus** `<name>/AGENT.md` directory form.

### Project level (`source: "project"`)

| Path | kind | providers |
|---|---|---|
| `.devin/skills` | skills | `["devin"]` |
| `.devin/agents` | both* | `["devin"]` |
| `.cognition/skills`, `.cognition/agents` | skills / both* | `["devin"]` |
| `.agents/skills`, `.agents/agents` | skills / both* | `["devin","codex","claude"]` |
| `.windsurf/skills` | skills | `["devin"]` |
| `.claude/skills` | skills | add `"devin"` to existing `["claude"]` |
| `.cursor/skills` | skills | add `"devin"` to existing `["cursor"]` |
| `.github/skills` | skills | `["devin","copilot"]` |
| `.devin/hooks.v1.json`, `.devin/config.json`, `.devin/config.local.json` | (hooks — not a skill surface; needed only if Mcode mirrors hook display) | `["devin"]` |

### Plugins (`source: "plugin"`)

* Devin plugin store: `%APPDATA%\devin\cli\plugins\` (state files verified; content layout `[unknown]` — needs one real `devin plugins install --local` to map). Plugin skills are namespaced `<plugin>:<skill>`; plugin dirs contain `skills/`, `rules/`, `agents/`, `hooks.json`, `.mcp.json`. Scan each installed plugin root like a plugin version dir, `providers: ["devin"]`, `prefix: <plugin-name>`.
* Repo-declared plugins: read `requiredPlugins`/`forbiddenPlugins` from `.devin/config.json` for display/blocked status.

### Notes and gaps

1. **`~/.agents/skills` is intentionally absent** from Mcode's generic catalog today (left to the Codex native catalog; `skill-service.ts:332` scans `~/.claude/.agents/skills` instead, which almost never exists). Devin reads `~/.agents/skills` directly, so a Devin provider needs it (shared `providers` tag is the cleanest fix).
2. **Do not** add `.copilot/skills` at project level (Devin does not scan it) or `.claude/agents` (not loaded despite docs).
3. Devin's own collision rule (native chain `.devin` > `.cognition` > `.agents`, cross-importer `<tag>:` prefixes) differs from Mcode's source-priority dedup (`user > project > agent > plugin`); Mcode's flat dedup is a reasonable approximation — exact prefix mirroring is optional polish.
4. `devin skills list --json` and `devin skills paths` are themselves cheap, auth-free probes — Mcode could optionally shell out to them for a live catalog rather than reimplementing the importer matrix.
5. Rules are context blobs, not slash-invocable; if Mcode adds a rules surface later, Section 4's table is the authoritative root list.

---

## 10. Primary Sources

### Local CLI evidence (devin 3000.10.21)

* `devin --help`, `devin skills|rules|plugins|mcp|migrate|acp --help`, `devin plugins install --help` — subcommand surface.
* `devin skills paths` / `devin rules paths` — native root printout.
* `devin skills list --json` (261 entries) — importer tags, `provider` field, `base_dir` census.
* `devin rules list`, `devin rules show AGENTS` — rule provider/activation labels.
* `devin doctor` (probe project) — `custom subagent profiles  4 profile(s) loaded`.
* Probe project at `%TEMP%\devin-probe` (since removed): same-named SKILL.md/agent/rule files across `.devin`, `.cognition`, `.agents`, `.windsurf`, `.claude`, `.cursor`, `.copilot`, `.github`, plus `commands/` variants.
* Binary strings in `devin.exe`: `available_commands_update`, `AvailableCommandMeta` (`cognition.ai/replacementText`, `cognition.ai/icon`), `plugins/list|install|remove|refresh|assets|review`, `cognition.ai/plugins/changed`, `config-importers/src/importers/*`, `.devin-plugin/plugin.json`, `.claude-plugin/{plugin,marketplace}.json`, `.devin/hooks.v1.json`, `~/.devin/plans/`, `https://api.devin.ai`, `https://static.devin.ai/cli/current/manifest.json`.

### Filesystem evidence

* `%APPDATA%\devin\` — `config.json`, `AGENTS.md`, `cli\plugins\{discovered,lock}.json`, `cli\sessions.db`, `references\`.
* `%LOCALAPPDATA%\devin\cli\` — `managed_plugins.*.bin`, `team_settings.*.bin`, `model_configs_v5.*.bin`, `user_status.*.bin`, `_versions\3000.10.21\`.
* `~\.devin\` — `argv.json`, `extensions\extensions.json` (Devin Desktop app-data, not CLI config).
* `~\.agents\skills` (69 skills), `~\.claude\skills` (65), `~\.cursor\skills` (86), `~\.copilot\skills` (36), `~\.claude\agents` (9, unloaded), `~\.codeium\windsurf\memories\global_rules.md`.

### Bundled docs (`%LOCALAPPDATA%\Programs\Devin\resources\app\extensions\windsurf\devin\share\devin\docs\`)

* `extensibility/index.mdx` — `.devin/` layout, importer table.
* `extensibility/skills/overview.mdx`, `creating-skills.mdx` — skill locations, SKILL.md frontmatter.
* `extensibility/rules.mdx` — rule files, activation types, `read_config_from`.
* `extensibility/plugins/overview.mdx`, `quickstart.mdx` — manifest, levels, marketplace convention.
* `extensibility/hooks/overview.mdx` — hook file locations.
* `subagents.mdx` §Custom Subagents — `agents/` layouts.
* `reference/configuration/{config-file,global-vs-local,read-config-from}.mdx` — config layers, importer matrix.
* `reference/commands.mdx` §devin skills/rules/plugins/acp, §Slash commands in ACP hosts (line 316).
* `acp/{jetbrains,zed,xcode}.mdx` — ACP slash-command advertising.

### Protocol / prior research

* `https://agentclientprotocol.com/protocol/slash-commands` — `available_commands_update` payload.
* `docs/research/devin-provider-research.md` — prior provider research (Devin 3000.6.19).
* `apps/server/src/features/agents/skills/catalog/skill-service.ts` — Mcode `ScanRoot`/`SkillSource` model and existing roots.
* `packages/providers/src/private/devin/devin-acp-event-mapper.ts` — existing Devin ACP adapter.
