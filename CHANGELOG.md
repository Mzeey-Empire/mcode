# Changelog

## [0.8.2](https://github.com/Mzeey-Emipre/mcode/compare/mcode-v0.8.1...mcode-v0.8.2) (2026-05-05)


### Bug Fixes

* **auto-updater:** use IPC return value for check-for-updates feedback ([#408](https://github.com/Mzeey-Emipre/mcode/issues/408)) ([e8808d5](https://github.com/Mzeey-Emipre/mcode/commit/e8808d5616d5ca490bdb22c5b07e006ca16001af))
* resolve project reorder failing on duplicate sort_order ([#406](https://github.com/Mzeey-Emipre/mcode/issues/406)) ([61517e5](https://github.com/Mzeey-Emipre/mcode/commit/61517e59ff8037812775bf319219c381212362d7))
* **web:** Ctrl+Enter for new project on landing and in browse palette ([#407](https://github.com/Mzeey-Emipre/mcode/issues/407)) ([f0375a5](https://github.com/Mzeey-Emipre/mcode/commit/f0375a52426f5c504ee8221469aee2d7d5e35810))
* **web:** landing and palette Ctrl+Enter for new project ([f0375a5](https://github.com/Mzeey-Emipre/mcode/commit/f0375a52426f5c504ee8221469aee2d7d5e35810))

## [0.8.1](https://github.com/Mzeey-Emipre/mcode/compare/mcode-v0.8.0...mcode-v0.8.1) (2026-05-05)


### Bug Fixes

* add schema patch for missing sort_order column on existing databases ([#404](https://github.com/Mzeey-Emipre/mcode/issues/404)) ([64cd42d](https://github.com/Mzeey-Emipre/mcode/commit/64cd42d4e3fae318314e190f7030c44b7ca6a498))

## [0.8.0](https://github.com/Mzeey-Emipre/mcode/compare/mcode-v0.7.0...mcode-v0.8.0) (2026-05-04)


### Features

* add performance.threadCacheSize setting ([#375](https://github.com/Mzeey-Emipre/mcode/issues/375)) ([1344cb3](https://github.com/Mzeey-Emipre/mcode/commit/1344cb3438bbb7d62167151dfb24c21b5a237e93))
* add staleness guard to github.checkStatus RPC handler ([#374](https://github.com/Mzeey-Emipre/mcode/issues/374)) ([cf79711](https://github.com/Mzeey-Emipre/mcode/commit/cf79711dcab9bce9857281cfe360956495aa1414))
* auto-updater with user controls, notifications, and release notes ([#368](https://github.com/Mzeey-Emipre/mcode/issues/368)) ([a77f2a4](https://github.com/Mzeey-Emipre/mcode/commit/a77f2a49571d5843e9eb0312f4e3dffc9548e974))
* Claude usage limits in sidebar popover + hover fix ([#376](https://github.com/Mzeey-Emipre/mcode/issues/376)) ([03e82e2](https://github.com/Mzeey-Emipre/mcode/commit/03e82e211b20cc802a1bc5419b22e0d7f00f893b))
* **cursor:** Cursor CLI provider, settings UI, and agent models discovery ([#373](https://github.com/Mzeey-Emipre/mcode/issues/373)) ([8cee807](https://github.com/Mzeey-Emipre/mcode/commit/8cee807dfc5ae8178c8a2b0f7230e90193dcd4ec))
* Drizzle migration framework + branch-aware dev DBs ([#393](https://github.com/Mzeey-Emipre/mcode/issues/393)) ([3eb79ca](https://github.com/Mzeey-Emipre/mcode/commit/3eb79ca457daec64e834ba52c53fb82a5f6db9b2))
* remove client-side CI check fan-out on reconnect ([#372](https://github.com/Mzeey-Emipre/mcode/issues/372)) ([2cbba86](https://github.com/Mzeey-Emipre/mcode/commit/2cbba86399e96bc5fb0756c81675397f93d0a70b))
* **server:** refresh child env from shell or registry on demand ([#394](https://github.com/Mzeey-Emipre/mcode/issues/394)) ([73bf7fb](https://github.com/Mzeey-Emipre/mcode/commit/73bf7fbe0d0aaf3a9eabcc55882a4e6dc02d5fea))
* **sidebar:** persist project sort order and drag reorder ([#389](https://github.com/Mzeey-Emipre/mcode/issues/389)) ([659b707](https://github.com/Mzeey-Emipre/mcode/commit/659b707f725cbcce267caab666e2df42f664562a))
* skip redundant RPCs on thread switch ([#333](https://github.com/Mzeey-Emipre/mcode/issues/333)) ([#371](https://github.com/Mzeey-Emipre/mcode/issues/371)) ([adce0af](https://github.com/Mzeey-Emipre/mcode/commit/adce0afd68f602e3627a5b950eab5cf59f38d5d1))
* **web:** eliminate MessageList unmount/remount on thread switch ([#370](https://github.com/Mzeey-Emipre/mcode/issues/370)) ([38141af](https://github.com/Mzeey-Emipre/mcode/commit/38141aff7a540959f2b06b266d3e0a5cee344897))
* **web:** LRU message cache for thread switching ([#369](https://github.com/Mzeey-Emipre/mcode/issues/369)) ([cbe53c6](https://github.com/Mzeey-Emipre/mcode/commit/cbe53c64296bb58db3740be66359c503cb5bf60d))
* **web:** modern project selector + unified command palette ([#378](https://github.com/Mzeey-Emipre/mcode/issues/378)) ([43a1326](https://github.com/Mzeey-Emipre/mcode/commit/43a1326e5698e087d4f571627f06c934f1291faa))
* **web:** optimistic thread scaffold during create and branch ([#387](https://github.com/Mzeey-Emipre/mcode/issues/387)) ([1c1b1a7](https://github.com/Mzeey-Emipre/mcode/commit/1c1b1a79830f268ed8d546c5ca5633aecefd68f9))


### Bug Fixes

* add per-model context window metadata for Claude models ([#356](https://github.com/Mzeey-Emipre/mcode/issues/356)) ([5134469](https://github.com/Mzeey-Emipre/mcode/commit/5134469fa3a13cb0ce7da8f7f28d5f58df3f3c1a))
* **cursor:** discover .cursor skills/commands/plugins and inject user AGENTS.md ([#381](https://github.com/Mzeey-Emipre/mcode/issues/381)) ([3e99b39](https://github.com/Mzeey-Emipre/mcode/commit/3e99b39772c5c221d9ea721f4840359dc5e61d68))
* **cursor:** persistent ACP subprocess and unified tool call handling ([#385](https://github.com/Mzeey-Emipre/mcode/issues/385)) ([e49d0eb](https://github.com/Mzeey-Emipre/mcode/commit/e49d0eb22655d53a60c5c530e6607f258a7a9784))
* **cursor:** suppress agent_thought_chunk to prevent thinking data leak ([04e7d34](https://github.com/Mzeey-Emipre/mcode/commit/04e7d34debdb47712ec077886cb43c70d0bac358))
* **cursor:** suppress thinking data leak in ACP responses ([#392](https://github.com/Mzeey-Emipre/mcode/issues/392)) ([04e7d34](https://github.com/Mzeey-Emipre/mcode/commit/04e7d34debdb47712ec077886cb43c70d0bac358))
* **desktop:** bundle server for dev without tsx loader ([#382](https://github.com/Mzeey-Emipre/mcode/issues/382)) ([14ad3a2](https://github.com/Mzeey-Emipre/mcode/commit/14ad3a26b694f7d3b05d354d37187a2219a503ca))
* persist user-selected model for dynamic provider IDs ([#388](https://github.com/Mzeey-Emipre/mcode/issues/388)) ([4e24692](https://github.com/Mzeey-Emipre/mcode/commit/4e246926954cf04345280dbec705557efea45767))
* rename packaged server process to 'Mcode Server' across platforms ([#377](https://github.com/Mzeey-Emipre/mcode/issues/377)) ([f58a7e1](https://github.com/Mzeey-Emipre/mcode/commit/f58a7e196f99119002abc37e06df140b134f9413))
* **server:** self-heal migrations on databases from older builds ([#395](https://github.com/Mzeey-Emipre/mcode/issues/395)) ([b8e423f](https://github.com/Mzeey-Emipre/mcode/commit/b8e423f2c50fecbeec53018a6e5d519c4285033c))
* **web:** align Cursor brand icon across Open menu and model selector ([60fd1d1](https://github.com/Mzeey-Emipre/mcode/commit/60fd1d15731e1430103ff9f9d990067114b54530))
* **web:** align Cursor brand icon in Open menu and model selector ([#379](https://github.com/Mzeey-Emipre/mcode/issues/379)) ([60fd1d1](https://github.com/Mzeey-Emipre/mcode/commit/60fd1d15731e1430103ff9f9d990067114b54530))
* **web:** cold-start landing add-project shortcuts and footer hints ([#380](https://github.com/Mzeey-Emipre/mcode/issues/380)) ([03b53fa](https://github.com/Mzeey-Emipre/mcode/commit/03b53faba266c0739d210a94c0fae546a4cb0488))
* **web:** hide invalid relative time and tidy recent projects landing ([#384](https://github.com/Mzeey-Emipre/mcode/issues/384)) ([1b2518c](https://github.com/Mzeey-Emipre/mcode/commit/1b2518c9fe33746d214239f496c7bd8ec5d9149a))
* **web:** New Thread palette flow, picker layout, stable E2E ([#386](https://github.com/Mzeey-Emipre/mcode/issues/386)) ([ea6993b](https://github.com/Mzeey-Emipre/mcode/commit/ea6993bcd7e00b31e01fc41ab1b0866a637304a2))
* **web:** prevent user chat bubble from overflowing horizontally ([#383](https://github.com/Mzeey-Emipre/mcode/issues/383)) ([62666e9](https://github.com/Mzeey-Emipre/mcode/commit/62666e9fb6e5bf8335cba7dcccfc06f6be832f02))

## [0.7.0](https://github.com/Mzeey-Emipre/mcode/compare/mcode-v0.6.0...mcode-v0.7.0) (2026-04-24)


### Features

* provider-scoped slash commands with multi-directory scanning ([#359](https://github.com/Mzeey-Emipre/mcode/issues/359)) ([0b2a07f](https://github.com/Mzeey-Emipre/mcode/commit/0b2a07ff5a4c3fb9cabe76c3927bdf1801d6bfc1))
* support non-git folders with graceful feature degradation ([#358](https://github.com/Mzeey-Emipre/mcode/issues/358)) ([961161e](https://github.com/Mzeey-Emipre/mcode/commit/961161e10e173c0d0e568150ecd84994eae8136a))


### Bug Fixes

* branch-from-chat reads naming settings and sanitizes on submit ([#357](https://github.com/Mzeey-Emipre/mcode/issues/357)) ([8c0e972](https://github.com/Mzeey-Emipre/mcode/commit/8c0e9722e00be83e719dc50a71dac58811a43f76))
* **build:** correct Linux binary name in smoke test ([#355](https://github.com/Mzeey-Emipre/mcode/issues/355)) ([8ec511c](https://github.com/Mzeey-Emipre/mcode/commit/8ec511c3460e3f34e2924ad7828a909a6b316edd))
* **build:** resolve release build failures ([#353](https://github.com/Mzeey-Emipre/mcode/issues/353)) ([847f1ec](https://github.com/Mzeey-Emipre/mcode/commit/847f1ec6f5dbed5684488120a7d99ba223b7d1d6))
* **build:** resolve tsyringe DI crash and Linux smoke test binary path ([847f1ec](https://github.com/Mzeey-Emipre/mcode/commit/847f1ec6f5dbed5684488120a7d99ba223b7d1d6))
* **build:** snapshot-safe subpath import for V8 snapshot entry ([#343](https://github.com/Mzeey-Emipre/mcode/issues/343)) ([c8804f5](https://github.com/Mzeey-Emipre/mcode/commit/c8804f5e3c3eb0614786a3984165ec069cedfca3))
* **build:** use snapshot-safe subpath import for V8 snapshot entry ([c8804f5](https://github.com/Mzeey-Emipre/mcode/commit/c8804f5e3c3eb0614786a3984165ec069cedfca3))
* close IPC relay socket and stderr stream on teardown ([#365](https://github.com/Mzeey-Emipre/mcode/issues/365)) ([d86ea30](https://github.com/Mzeey-Emipre/mcode/commit/d86ea30c8bd31d6336fde48d6c1433fefe3f04ad))
* **copilot:** preserve running state during agentic tool-use loops ([#363](https://github.com/Mzeey-Emipre/mcode/issues/363)) ([4920b3b](https://github.com/Mzeey-Emipre/mcode/commit/4920b3b8224e505c63278fab595c2240843c5e91))
* deduplicate check runs to show only latest per workflow ([#364](https://github.com/Mzeey-Emipre/mcode/issues/364)) ([ce8b55a](https://github.com/Mzeey-Emipre/mcode/commit/ce8b55ad9d65879f10a34bfbfb36cbf6ba819e0f))
* **desktop:** harden server startup reliability ([#344](https://github.com/Mzeey-Emipre/mcode/issues/344)) ([3fe2072](https://github.com/Mzeey-Emipre/mcode/commit/3fe2072fbac2cab37a8c51eaec0d501b2cbfaf6c))
* inject user-level Copilot instructions, skills, and commands ([#362](https://github.com/Mzeey-Emipre/mcode/issues/362)) ([6b0ab58](https://github.com/Mzeey-Emipre/mcode/commit/6b0ab585d15c4790ee81b943e75599a3c31a3647))
* reduce GitHub API rate limit exposure in CI watcher ([#361](https://github.com/Mzeey-Emipre/mcode/issues/361)) ([cb2a0c9](https://github.com/Mzeey-Emipre/mcode/commit/cb2a0c97e85b295e393e75ba4d10541f9080ceda))

## [0.6.0](https://github.com/Mzeey-Emipre/mcode/compare/mcode-v0.5.0...mcode-v0.6.0) (2026-04-21)


### Features

* **codex:** supervised permission mode ([#326](https://github.com/Mzeey-Emipre/mcode/issues/326)) ([dda1a03](https://github.com/Mzeey-Emipre/mcode/commit/dda1a031d5708a71ff5b2de0b9c563018ce28dfa))
* per-provider enable/disable with CLI verification ([#322](https://github.com/Mzeey-Emipre/mcode/issues/322)) ([dce716d](https://github.com/Mzeey-Emipre/mcode/commit/dce716d1b94772143660dc9fe17792da62087a85))
* **sidebar:** differentiate action-required threads with hollow amber ring ([#299](https://github.com/Mzeey-Emipre/mcode/issues/299)) ([5cd12a2](https://github.com/Mzeey-Emipre/mcode/commit/5cd12a2a4104f35035977e3a75602de50bbaa91e))
* **sidebar:** reclaim full chat width when collapsed ([#301](https://github.com/Mzeey-Emipre/mcode/issues/301)) ([a04113c](https://github.com/Mzeey-Emipre/mcode/commit/a04113c3c9cda18d9f34d63d11fd10f2ffc736e0))
* **terminal:** stability pass — scrollback cap, debounced resize, WebGL renderer ([#320](https://github.com/Mzeey-Emipre/mcode/issues/320)) ([cb6c12b](https://github.com/Mzeey-Emipre/mcode/commit/cb6c12b528fd25bae235b0e5b9e2ef9a71d1ca57))
* **terminal:** Stream C — binary frames, flow control, pause on hide ([#310](https://github.com/Mzeey-Emipre/mcode/issues/310) [#309](https://github.com/Mzeey-Emipre/mcode/issues/309) [#312](https://github.com/Mzeey-Emipre/mcode/issues/312)) ([#325](https://github.com/Mzeey-Emipre/mcode/issues/325)) ([dab22a1](https://github.com/Mzeey-Emipre/mcode/commit/dab22a1c0bd5e87804883c60d60f19ea2c60ff66))
* **terminal:** Streams D & E - session replay, PTY lifecycle hardening, kill confirmation ([#329](https://github.com/Mzeey-Emipre/mcode/issues/329)) ([6ec469e](https://github.com/Mzeey-Emipre/mcode/commit/6ec469efdd0853d9e0430ccad804bade45c16974))
* **ui:** redesign SidebarUsagePanel for clarity and theme cohesion ([#297](https://github.com/Mzeey-Emipre/mcode/issues/297)) ([dedb13e](https://github.com/Mzeey-Emipre/mcode/commit/dedb13e35e4b029ac91645900705fa71aceda109))


### Bug Fixes

* apply permission mode toggle to existing Claude threads ([#300](https://github.com/Mzeey-Emipre/mcode/issues/300)) ([c9a9404](https://github.com/Mzeey-Emipre/mcode/commit/c9a9404b1bcee79d140e61e05ddd5dae94d1f4a1))
* **chat:** prevent invalid mermaid from leaving error diagram at page bottom ([#324](https://github.com/Mzeey-Emipre/mcode/issues/324)) ([4a1eebe](https://github.com/Mzeey-Emipre/mcode/commit/4a1eebe4fc61b2f39f9fb0a5279e25f31ceda2a0))
* **ci:** surface GitHub Actions status in the new UI ([#298](https://github.com/Mzeey-Emipre/mcode/issues/298)) ([2d7e0e6](https://github.com/Mzeey-Emipre/mcode/commit/2d7e0e65cf816bfa4a30fe965ea958d4b404d1f0))
* **copilot:** restore dynamic model listing ([#327](https://github.com/Mzeey-Emipre/mcode/issues/327)) ([35a0af4](https://github.com/Mzeey-Emipre/mcode/commit/35a0af4ecb18b0aecc0f3976aa1b62d7c78976de))
* resilient auth recovery and orphan cleanup for long-running tasks ([#282](https://github.com/Mzeey-Emipre/mcode/issues/282)) ([1dd16f9](https://github.com/Mzeey-Emipre/mcode/commit/1dd16f94861d7e431b2bbc3ff598680bb4d41fed))
* resolve four idle-session issues from PR [#282](https://github.com/Mzeey-Emipre/mcode/issues/282) follow-up ([#296](https://github.com/Mzeey-Emipre/mcode/issues/296)) ([6468235](https://github.com/Mzeey-Emipre/mcode/commit/64682356b73f596f165e429e5153002e5a7e35c7))
* **sidebar:** copy thread's worktree path, not project path ([#317](https://github.com/Mzeey-Emipre/mcode/issues/317)) ([7e7164b](https://github.com/Mzeey-Emipre/mcode/commit/7e7164b28e789acd91cc7194deb20adb8d83608a))
* **sidebar:** reflect running state for non-user-initiated sessions ([#321](https://github.com/Mzeey-Emipre/mcode/issues/321)) ([71c3c0b](https://github.com/Mzeey-Emipre/mcode/commit/71c3c0bafa617e50323922df6a14031f39e4f30c))
* **slash-commands:** comprehensive fix for intermittent loading failures ([#319](https://github.com/Mzeey-Emipre/mcode/issues/319)) ([197e423](https://github.com/Mzeey-Emipre/mcode/commit/197e4234b5d92480c267fc0cde884c7969c5b1d9))
* **terminal:** four stability fixes for the embedded terminal ([#318](https://github.com/Mzeey-Emipre/mcode/issues/318)) ([203b764](https://github.com/Mzeey-Emipre/mcode/commit/203b764cff427ade3697275c9bdbfad02ca13039))

## [0.5.0](https://github.com/Mzeey-Emipre/mcode/compare/mcode-v0.4.0...mcode-v0.5.0) (2026-04-17)


### Features

* markdown preview toggle for .md/.mdx diffs ([#289](https://github.com/Mzeey-Emipre/mcode/issues/289)) ([f8c4cda](https://github.com/Mzeey-Emipre/mcode/commit/f8c4cdaf0e8c2b880c779c1c634d450309af5909))
* **ui:** floating panel layout, composer overflow popover, warm theme refresh ([#287](https://github.com/Mzeey-Emipre/mcode/issues/287)) ([184a4d1](https://github.com/Mzeey-Emipre/mcode/commit/184a4d181d5f0bab5202fc550fe64cff45be5beb))


### Bug Fixes

* Claude reasoning tier ordering, Sonnet max support, and Haiku picker hiding ([#288](https://github.com/Mzeey-Emipre/mcode/issues/288)) ([7ce7cc4](https://github.com/Mzeey-Emipre/mcode/commit/7ce7cc434649dfb4aa5eb8ee887c4d53a9a3f4c2))

## [0.4.0](https://github.com/Mzeey-Emipre/mcode/compare/mcode-v0.3.0...mcode-v0.4.0) (2026-04-17)


### Features

* add Claude Opus 4.7 with xhigh reasoning effort ([#283](https://github.com/Mzeey-Emipre/mcode/issues/283)) ([6aa9913](https://github.com/Mzeey-Emipre/mcode/commit/6aa99132168c873db8d3723def6112570a59ecdd))
* spellcheck context menu for Composer editor ([#280](https://github.com/Mzeey-Emipre/mcode/issues/280)) ([bbbfad6](https://github.com/Mzeey-Emipre/mcode/commit/bbbfad64185cb14d71cafd77210a330c1850e22b))


### Bug Fixes

* **desktop:** bundle copilot-sdk into server instead of externalizing it ([2113fda](https://github.com/Mzeey-Emipre/mcode/commit/2113fdafd0380d63ab60e1dd4d9fb68af0dc8f2d))
* **desktop:** bundle copilot-sdk to fix server startup in packaged app ([#279](https://github.com/Mzeey-Emipre/mcode/issues/279)) ([2113fda](https://github.com/Mzeey-Emipre/mcode/commit/2113fdafd0380d63ab60e1dd4d9fb68af0dc8f2d))

## [0.3.0](https://github.com/Mzeey-Emipre/mcode/compare/mcode-v0.2.0...mcode-v0.3.0) (2026-04-15)


### Features

* add GitHub Copilot as an AI provider ([#253](https://github.com/Mzeey-Emipre/mcode/issues/253)) ([33360df](https://github.com/Mzeey-Emipre/mcode/commit/33360df77e2f42214214c2830b74a41bb0425207))
* add maxBudgetUsd and maxTurns guardrails (Claude only) ([#271](https://github.com/Mzeey-Emipre/mcode/issues/271)) ([6406920](https://github.com/Mzeey-Emipre/mcode/commit/6406920e0550c0c89c6518e9593d6e1ea1c9e3b7))
* add provider usage tracking panel ([#267](https://github.com/Mzeey-Emipre/mcode/issues/267)) ([11f01bd](https://github.com/Mzeey-Emipre/mcode/commit/11f01bddfc8bf1fd175391820628f895e9f9e724))
* **db:** versioned migration framework with rollback and CLI ([#249](https://github.com/Mzeey-Emipre/mcode/issues/249)) ([49c3fbe](https://github.com/Mzeey-Emipre/mcode/commit/49c3fbeb5041bb2089c6b26303363d4f71f43801))
* decouple server from Electron process lifecycle ([#265](https://github.com/Mzeey-Emipre/mcode/issues/265)) ([feab4da](https://github.com/Mzeey-Emipre/mcode/commit/feab4dac269e32461a9fd537bfc7a6fa25ba764a))
* expose Copilot sub-agents as selectable modes in the Composer ([#272](https://github.com/Mzeey-Emipre/mcode/issues/272)) ([5af8fe1](https://github.com/Mzeey-Emipre/mcode/commit/5af8fe15a1488f38586e29d09b0e9fc8529b9a49))
* GitHub Actions check status on threads ([#210](https://github.com/Mzeey-Emipre/mcode/issues/210)) ([#273](https://github.com/Mzeey-Emipre/mcode/issues/273)) ([eca6041](https://github.com/Mzeey-Emipre/mcode/commit/eca604184290e3fec25d95ffb4259ea1f4010a6e))
* implement command palette with keyboard shortcuts ([#250](https://github.com/Mzeey-Emipre/mcode/issues/250)) ([ae34100](https://github.com/Mzeey-Emipre/mcode/commit/ae34100ece7645790fb9b38d4acd6d279a34f432))
* implement complete() on CopilotProvider for PR draft generation ([#275](https://github.com/Mzeey-Emipre/mcode/issues/275)) ([b0e8646](https://github.com/Mzeey-Emipre/mcode/commit/b0e86467ab1f3326125ec4eed44ceb2063d34919))
* implement supervised permission mode for Claude provider ([#277](https://github.com/Mzeey-Emipre/mcode/issues/277)) ([3a2d905](https://github.com/Mzeey-Emipre/mcode/commit/3a2d9051c9de98c311b5b995494977dfa720bed5))
* markdown rendering for user messages and Mermaid diagram visualizer ([#264](https://github.com/Mzeey-Emipre/mcode/issues/264)) ([aeb1555](https://github.com/Mzeey-Emipre/mcode/commit/aeb1555c6b38e655192d6b68b9a27e01ee371ba0))
* per-thread panel state for terminal and right panel ([#263](https://github.com/Mzeey-Emipre/mcode/issues/263)) ([f5c9663](https://github.com/Mzeey-Emipre/mcode/commit/f5c9663ae39460e68e701e6908c9ba8bf8b29cf9))
* show context window usage gauge for Copilot sessions ([#262](https://github.com/Mzeey-Emipre/mcode/issues/262)) ([5e8dd70](https://github.com/Mzeey-Emipre/mcode/commit/5e8dd70638381da353104a24ce2ba18779caa95c))


### Bug Fixes

* clean worktree deletion and parent dir cleanup ([#252](https://github.com/Mzeey-Emipre/mcode/issues/252)) ([6a134a5](https://github.com/Mzeey-Emipre/mcode/commit/6a134a570f157a6f87fe5aee1d2c5760cb822d14))
* open links in external browser instead of in-app ([#254](https://github.com/Mzeey-Emipre/mcode/issues/254)) ([0ed6350](https://github.com/Mzeey-Emipre/mcode/commit/0ed6350584d0f0611b9cf21fd38d565155628533))
* pass auth token to browser in dev:web mode ([#268](https://github.com/Mzeey-Emipre/mcode/issues/268)) ([7b397d0](https://github.com/Mzeey-Emipre/mcode/commit/7b397d0d1df888d00d1688400ab37a5532050a52))
* worktree parent directory cleanup on Windows ([#274](https://github.com/Mzeey-Emipre/mcode/issues/274)) ([aef5fe6](https://github.com/Mzeey-Emipre/mcode/commit/aef5fe626e5379c0f171d9b68ceef3486627af9e))


### Performance Improvements

* lazy-load react-markdown and cmdk ([#251](https://github.com/Mzeey-Emipre/mcode/issues/251)) ([3c6aa15](https://github.com/Mzeey-Emipre/mcode/commit/3c6aa15322fc8fc8fdaa93b152ba948f88207a53))

## [0.2.0](https://github.com/Mzeey-Emipre/mcode/compare/mcode-v0.1.0...mcode-v0.2.0) (2026-04-09)


### Features

* bundle server into packaged desktop app ([#237](https://github.com/Mzeey-Emipre/mcode/issues/237)) ([c1fa845](https://github.com/Mzeey-Emipre/mcode/commit/c1fa8458715b8820e46f4d6a2525d0e1f5793cab))
* improve diff view UX ([#240](https://github.com/Mzeey-Emipre/mcode/issues/240)) ([0386cef](https://github.com/Mzeey-Emipre/mcode/commit/0386cef1a33f92f3c77bac7522b3a797fe4f2ae5))
* PR creation flow with AI draft generation and polished dialog ([#213](https://github.com/Mzeey-Emipre/mcode/issues/213)) ([90ff875](https://github.com/Mzeey-Emipre/mcode/commit/90ff875f4ebf2a64ea30571878b00074c50d256d))


### Bug Fixes

* add author and homepage for Linux packaging ([#231](https://github.com/Mzeey-Emipre/mcode/issues/231)) ([f1da0f9](https://github.com/Mzeey-Emipre/mcode/commit/f1da0f9d4fd646b120869b85407724964ce4f30e))
* add author and homepage to desktop package.json ([f1da0f9](https://github.com/Mzeey-Emipre/mcode/commit/f1da0f9d4fd646b120869b85407724964ce4f30e))
* add author email for Linux deb/AppImage packaging ([#232](https://github.com/Mzeey-Emipre/mcode/issues/232)) ([d432e09](https://github.com/Mzeey-Emipre/mcode/commit/d432e090e4313b272ed58eda83a45655c2dcbead))
* add author email required by Linux deb/AppImage packaging ([d432e09](https://github.com/Mzeey-Emipre/mcode/commit/d432e090e4313b272ed58eda83a45655c2dcbead))
* add contents write permission for release artifact upload ([2608744](https://github.com/Mzeey-Emipre/mcode/commit/260874488e8817f5538c0c9b7c1f6b8fd89b34f5))
* add contents write permission for release uploads ([#233](https://github.com/Mzeey-Emipre/mcode/issues/233)) ([2608744](https://github.com/Mzeey-Emipre/mcode/commit/260874488e8817f5538c0c9b7c1f6b8fd89b34f5))
* add electron-mksnapshot to trustedDependencies for CI builds ([#223](https://github.com/Mzeey-Emipre/mcode/issues/223)) ([3b693b5](https://github.com/Mzeey-Emipre/mcode/commit/3b693b51522d6f201f0651a1ffc074b624c59be8))
* codex provider reliability and session resume ([#247](https://github.com/Mzeey-Emipre/mcode/issues/247)) ([e7c294f](https://github.com/Mzeey-Emipre/mcode/commit/e7c294fc39e309d630aa356e36c82e0562c92aa8))
* correct author email for Linux packaging ([#234](https://github.com/Mzeey-Emipre/mcode/issues/234)) ([9ff4902](https://github.com/Mzeey-Emipre/mcode/commit/9ff490245ec3ff1d366ce7903d2d1f01ae81c123))
* correct packaged server path and install native deps before packaging ([#242](https://github.com/Mzeey-Emipre/mcode/issues/242)) ([a98b2ed](https://github.com/Mzeey-Emipre/mcode/commit/a98b2ed3489efb5c719ebe0e5f61912554655c9c))
* disable npm workspace mode in CI packaging ([#228](https://github.com/Mzeey-Emipre/mcode/issues/228)) ([b6d7d20](https://github.com/Mzeey-Emipre/mcode/commit/b6d7d2025df90474482b1669d47cb60b114c8b43))
* disable npm workspace mode in CI packaging script ([b6d7d20](https://github.com/Mzeey-Emipre/mcode/commit/b6d7d2025df90474482b1669d47cb60b114c8b43))
* exclude unpacked binaries and NSIS helpers from release artifacts ([#236](https://github.com/Mzeey-Emipre/mcode/issues/236)) ([5a2fbd2](https://github.com/Mzeey-Emipre/mcode/commit/5a2fbd2b66fdb75e3fd5781b5ee5e3a7bf39fdb8))
* invalidate worktree cache after creating worktree thread ([8383d2c](https://github.com/Mzeey-Emipre/mcode/commit/8383d2cbe4ca171569e59e2dd3e38847f704f849))
* isolate agent events to their originating thread ([#241](https://github.com/Mzeey-Emipre/mcode/issues/241)) ([aa6604c](https://github.com/Mzeey-Emipre/mcode/commit/aa6604c9534885b484a619501dae543f8bd078c1))
* lazy-load native modules and separate packaged app port ([#245](https://github.com/Mzeey-Emipre/mcode/issues/245)) ([3b9148f](https://github.com/Mzeey-Emipre/mcode/commit/3b9148f9c06441ca0db943ee047efcd2d2e00895))
* new worktree threads incorrectly shown as read-only ([#220](https://github.com/Mzeey-Emipre/mcode/issues/220)) ([8383d2c](https://github.com/Mzeey-Emipre/mcode/commit/8383d2cbe4ca171569e59e2dd3e38847f704f849))
* package bundled server native deps ([#243](https://github.com/Mzeey-Emipre/mcode/issues/243)) ([3c9684a](https://github.com/Mzeey-Emipre/mcode/commit/3c9684a87cc023295f922698d79b9aa46c90c33b))
* resolve electron-builder CLI via node instead of .bin shims ([#227](https://github.com/Mzeey-Emipre/mcode/issues/227)) ([68498ee](https://github.com/Mzeey-Emipre/mcode/commit/68498eea11bd40332952d8403c226efc8b2f2991))
* resolve packaged desktop app server startup failures ([#246](https://github.com/Mzeey-Emipre/mcode/issues/246)) ([45bfa09](https://github.com/Mzeey-Emipre/mcode/commit/45bfa090e813e2ca1e0ec3cb9ccfcc3316af1f9e))
* strip workspace deps before electron-builder packaging ([#225](https://github.com/Mzeey-Emipre/mcode/issues/225)) ([60345ad](https://github.com/Mzeey-Emipre/mcode/commit/60345ade773fa9fd8f1373b3027d0530c1663cba))
* strip workspaces from root package.json before electron-builder ([#229](https://github.com/Mzeey-Emipre/mcode/issues/229)) ([b681512](https://github.com/Mzeey-Emipre/mcode/commit/b681512bdc9245e50021af300ebc9c3ca8e3334e))
* use dedicated CI packaging script for electron-builder ([#226](https://github.com/Mzeey-Emipre/mcode/issues/226)) ([86ddf5f](https://github.com/Mzeey-Emipre/mcode/commit/86ddf5f32deef1476cd322b60e6eaffdb1267070))
* use executableName for Linux binary in after-pack hook ([#230](https://github.com/Mzeey-Emipre/mcode/issues/230)) ([fa44d8e](https://github.com/Mzeey-Emipre/mcode/commit/fa44d8ef3ffc38ffc263d2d4ab4e4f1899737b98))
* use executableName for Linux binary path in after-pack hook ([fa44d8e](https://github.com/Mzeey-Emipre/mcode/commit/fa44d8ef3ffc38ffc263d2d4ab4e4f1899737b98))
* use gh release upload to preserve release description ([#235](https://github.com/Mzeey-Emipre/mcode/issues/235)) ([e4aae5c](https://github.com/Mzeey-Emipre/mcode/commit/e4aae5c395c4ebc232656391330b259b902b3b97))
* work around electron-builder bun detection bug in CI ([#224](https://github.com/Mzeey-Emipre/mcode/issues/224)) ([6184ffe](https://github.com/Mzeey-Emipre/mcode/commit/6184ffe23b304225a639f0037d5f47530502bd85))


### Performance Improvements

* thread branching optimisations ([#221](https://github.com/Mzeey-Emipre/mcode/issues/221)) ([6a331c7](https://github.com/Mzeey-Emipre/mcode/commit/6a331c7ab682d57009ab6db4cc009969e7e15e76))

## [0.1.0](https://github.com/Mzeey-Emipre/mcode/compare/mcode-v0.0.1...mcode-v0.1.0) (2026-04-08)


### Features

* @ file tagging with content injection ([#36](https://github.com/Mzeey-Emipre/mcode/issues/36)) ([4e24684](https://github.com/Mzeey-Emipre/mcode/commit/4e24684818b36c1ecfcf8a7935a26edc5889eb4d))
* add API wiring, Tauri commands, and graceful shutdown ([#3](https://github.com/Mzeey-Emipre/mcode/issues/3)) ([0b28593](https://github.com/Mzeey-Emipre/mcode/commit/0b285934b33dff21b4fb3f8a30f9002aad07b807))
* add Codex provider support with per-model reasoning levels ([#169](https://github.com/Mzeey-Emipre/mcode/issues/169)) ([184d2fe](https://github.com/Mzeey-Emipre/mcode/commit/184d2fea514b593e7f422daa72891581246f4afc))
* add context window tracker and compaction support ([#164](https://github.com/Mzeey-Emipre/mcode/issues/164)) ([895f210](https://github.com/Mzeey-Emipre/mcode/commit/895f2108681ed987527cf0d47f20b9c4ef3d55b3))
* add core data layer and CodeRabbit fixes ([#2](https://github.com/Mzeey-Emipre/mcode/issues/2)) ([0278ba5](https://github.com/Mzeey-Emipre/mcode/commit/0278ba5d5186481335258d72146c2201a0221ecb))
* add diff view panel ([#181](https://github.com/Mzeey-Emipre/mcode/issues/181)) ([7e776a9](https://github.com/Mzeey-Emipre/mcode/commit/7e776a93a172e4919949cb274f9f43280d066c42))
* add F2 shortcut to rename threads ([#33](https://github.com/Mzeey-Emipre/mcode/issues/33)) ([faa2fba](https://github.com/Mzeey-Emipre/mcode/commit/faa2fba468e4d0ba261ab684066096ea44608452))
* add fallback model for resilience when primary model is unavailable ([#162](https://github.com/Mzeey-Emipre/mcode/issues/162)) ([4db3d46](https://github.com/Mzeey-Emipre/mcode/commit/4db3d464d287d7220e3b1ad36e11c4b66ef43ff7))
* add frontend UI with sidebar, chat, and settings ([#4](https://github.com/Mzeey-Emipre/mcode/issues/4)) ([7d128ae](https://github.com/Mzeey-Emipre/mcode/commit/7d128aebd590a536119e75fa120e341d03c20eba))
* add image and file attachment support for chat ([#31](https://github.com/Mzeey-Emipre/mcode/issues/31)) ([24f9f57](https://github.com/Mzeey-Emipre/mcode/commit/24f9f57e2663e509647bc5b90977f74383725754))
* add Open in Editor dropdown and PR badge to chat header ([#37](https://github.com/Mzeey-Emipre/mcode/issues/37)) ([7c70edd](https://github.com/Mzeey-Emipre/mcode/commit/7c70edd55582b669d3cdffc403d0fce4273587e4))
* add production build script for desktop app ([#11](https://github.com/Mzeey-Emipre/mcode/issues/11)) ([64e7e97](https://github.com/Mzeey-Emipre/mcode/commit/64e7e97eedc830c7360753767e293578c552ebb8))
* add settings view with sidebar navigation ([#166](https://github.com/Mzeey-Emipre/mcode/issues/166)) ([6f53dfe](https://github.com/Mzeey-Emipre/mcode/commit/6f53dfeffcc1fa69b17416db3f8ceedeb1ed1ecb))
* add syntax highlighting to agent chat bubbles ([#82](https://github.com/Mzeey-Emipre/mcode/issues/82)) ([5a67f63](https://github.com/Mzeey-Emipre/mcode/commit/5a67f631e920d8040c1c718118ee1a053b93dbd6))
* background worktree cleanup with exponential backoff ([#167](https://github.com/Mzeey-Emipre/mcode/issues/167)) ([18a736f](https://github.com/Mzeey-Emipre/mcode/commit/18a736fd6620a5d8fa130f448be3c38335d35979))
* **ci:** release pipeline for Windows and Linux builds with auto-update ([#189](https://github.com/Mzeey-Emipre/mcode/issues/189)) ([84e47dc](https://github.com/Mzeey-Emipre/mcode/commit/84e47dcf41827f867f41a335cd91a994a2bf8581))
* configurable V8 heap limit for server process ([#119](https://github.com/Mzeey-Emipre/mcode/issues/119)) ([94f747d](https://github.com/Mzeey-Emipre/mcode/commit/94f747dba1cda6c55b94ce0b69647cf9cdacffa6))
* configurable worktree branching strategy ([#30](https://github.com/Mzeey-Emipre/mcode/issues/30)) ([6b0bf87](https://github.com/Mzeey-Emipre/mcode/commit/6b0bf87b5b43de23c9966c9d34adddcbcca43b8d))
* detect plugin slash commands and inline token highlighting ([#56](https://github.com/Mzeey-Emipre/mcode/issues/56)) ([760cfd8](https://github.com/Mzeey-Emipre/mcode/commit/760cfd877c1a80620aaa21cabed65ae88a52f318))
* double-click to rename threads in sidebar and chat header ([#202](https://github.com/Mzeey-Emipre/mcode/issues/202)) ([7ce3018](https://github.com/Mzeey-Emipre/mcode/commit/7ce30182f85ee2c860abcec6d65c6d3c04fed637))
* enable full Claude SDK integration (config, permissions, tools) ([#9](https://github.com/Mzeey-Emipre/mcode/issues/9)) ([98335d3](https://github.com/Mzeey-Emipre/mcode/commit/98335d32faec5367883355ec5f11ce5885591bb9))
* fix thread context menu and add delete confirmation ([#19](https://github.com/Mzeey-Emipre/mcode/issues/19)) ([6e8574c](https://github.com/Mzeey-Emipre/mcode/commit/6e8574c2fb29a939df9e783b942090b9af26d0b4))
* implement completed/errored thread status lifecycle ([#29](https://github.com/Mzeey-Emipre/mcode/issues/29)) ([696b076](https://github.com/Mzeey-Emipre/mcode/commit/696b076927d77c824cf14abd08e61d8154d3d25b))
* implement settings.json as single source of truth ([#112](https://github.com/Mzeey-Emipre/mcode/issues/112)) ([#114](https://github.com/Mzeey-Emipre/mcode/issues/114)) ([d6abc3a](https://github.com/Mzeey-Emipre/mcode/commit/d6abc3ad725fab84b40692f4e1df847e6b6849cd))
* improve diff viewer with syntax highlighting and hunk separators ([#201](https://github.com/Mzeey-Emipre/mcode/issues/201)) ([7c598d7](https://github.com/Mzeey-Emipre/mcode/commit/7c598d709097babf0b927f162f215c5efd7c2dbd))
* inline turn change summary with auto-collapse ([#200](https://github.com/Mzeey-Emipre/mcode/issues/200)) ([90aa08e](https://github.com/Mzeey-Emipre/mcode/commit/90aa08ef79b447d06be2696f0223a3f98c271df8))
* integrated terminal panel (Ctrl+J) ([#39](https://github.com/Mzeey-Emipre/mcode/issues/39)) ([e99590b](https://github.com/Mzeey-Emipre/mcode/commit/e99590b762ac1718d0a02b2da119b5f0998a5c49))
* message queuing for sequential delivery ([#64](https://github.com/Mzeey-Emipre/mcode/issues/64)) ([46e7588](https://github.com/Mzeey-Emipre/mcode/commit/46e7588f308661dedbedc31c3c60eee7d1abef25)), closes [#26](https://github.com/Mzeey-Emipre/mcode/issues/26)
* migrate Composer from textarea to Lexical editor ([#66](https://github.com/Mzeey-Emipre/mcode/issues/66)) ([222dc9d](https://github.com/Mzeey-Emipre/mcode/commit/222dc9d020ebcd65d6540d5401d8729b3c37f7fb))
* migrate to Electron + T3 Code UX parity ([#5](https://github.com/Mzeey-Emipre/mcode/issues/5)) ([ef759b6](https://github.com/Mzeey-Emipre/mcode/commit/ef759b66d22df306d62f4c480e28076cb2d90332))
* persist last-used model and reasoning level ([#128](https://github.com/Mzeey-Emipre/mcode/issues/128)) ([20727ab](https://github.com/Mzeey-Emipre/mcode/commit/20727abe6a3d32c95a0cf405c995d980039f3402))
* plan mode questions wizard ([#185](https://github.com/Mzeey-Emipre/mcode/issues/185)) ([40a3487](https://github.com/Mzeey-Emipre/mcode/commit/40a3487d0ce6b570e2ea2d576d6cc551f5a900f2))
* PR review workflow with branch fetching and worktree integration ([#65](https://github.com/Mzeey-Emipre/mcode/issues/65)) ([63b8edb](https://github.com/Mzeey-Emipre/mcode/commit/63b8edba50629daa38e3b15e4b5993c3a86e84b0))
* redesign tool call UX with progressive disclosure ([#74](https://github.com/Mzeey-Emipre/mcode/issues/74)) ([4545b96](https://github.com/Mzeey-Emipre/mcode/commit/4545b96a94040537ef7b523500d7bf31297e0845))
* running terminal indicator in chat area ([#199](https://github.com/Mzeey-Emipre/mcode/issues/199)) ([3fa2e42](https://github.com/Mzeey-Emipre/mcode/commit/3fa2e42d6348bec3c13d081420025310261206c7))
* semantic tool call rendering with per-type renderers ([#57](https://github.com/Mzeey-Emipre/mcode/issues/57)) ([660c3fa](https://github.com/Mzeey-Emipre/mcode/commit/660c3fae65406024ad7719c2107c6bf3be8148f7))
* semantic tool call rendering with per-type renderers and animations ([660c3fa](https://github.com/Mzeey-Emipre/mcode/commit/660c3fae65406024ad7719c2107c6bf3be8148f7))
* slash command autocomplete with skills ([#17](https://github.com/Mzeey-Emipre/mcode/issues/17)) ([#38](https://github.com/Mzeey-Emipre/mcode/issues/38)) ([1485216](https://github.com/Mzeey-Emipre/mcode/commit/1485216d0469ffd42372628d632f9210166c2c4f))
* stream text through collapsible StreamingCard ([#165](https://github.com/Mzeey-Emipre/mcode/issues/165)) ([8ea6864](https://github.com/Mzeey-Emipre/mcode/commit/8ea686413190e68bca1d8bbb27e3d111118feeb4))
* thread branching with parent-child lineage ([#214](https://github.com/Mzeey-Emipre/mcode/issues/214)) ([3d83726](https://github.com/Mzeey-Emipre/mcode/commit/3d83726bffb39c58ac8e3a1b3fa5ae7bee2553da))
* TodoWrite task panel with persistence ([#140](https://github.com/Mzeey-Emipre/mcode/issues/140)) ([92837ed](https://github.com/Mzeey-Emipre/mcode/commit/92837ed262859dd538f40a7b90adaa0ab2468f06))
* UX improvements — provider icons, PR state badges, editor icons ([#122](https://github.com/Mzeey-Emipre/mcode/issues/122)) ([e7e12d8](https://github.com/Mzeey-Emipre/mcode/commit/e7e12d8c71ae85aa01cf9c5d18492ed8d19e4926))
* **web:** add terminal toggle button to header ([9a79cdf](https://github.com/Mzeey-Emipre/mcode/commit/9a79cdfe6c414daa8c12327a355a5458ef596264))
* **web:** improve accessibility across chat components ([9a79cdf](https://github.com/Mzeey-Emipre/mcode/commit/9a79cdfe6c414daa8c12327a355a5458ef596264))
* **web:** improve chat composer, message flow, and tool call UX ([#131](https://github.com/Mzeey-Emipre/mcode/issues/131)) ([9a79cdf](https://github.com/Mzeey-Emipre/mcode/commit/9a79cdfe6c414daa8c12327a355a5458ef596264))
* **web:** project tree PR icons, badge fix, and pagination ([#136](https://github.com/Mzeey-Emipre/mcode/issues/136)) ([c16e2c9](https://github.com/Mzeey-Emipre/mcode/commit/c16e2c956b589cee198259e6dc2031ee9b1c5b04))
* **web:** redesign PR detection and header actions ([9a79cdf](https://github.com/Mzeey-Emipre/mcode/commit/9a79cdfe6c414daa8c12327a355a5458ef596264))
* **web:** standardize button usage on chat primitives ([9a79cdf](https://github.com/Mzeey-Emipre/mcode/commit/9a79cdfe6c414daa8c12327a355a5458ef596264))


### Bug Fixes

* add loading state to delete thread dialog ([#81](https://github.com/Mzeey-Emipre/mcode/issues/81)) ([0207bad](https://github.com/Mzeey-Emipre/mcode/commit/0207badd24776952175cac35023976e8d6c3fa36))
* add path filter to release-please workflow ([#198](https://github.com/Mzeey-Emipre/mcode/issues/198)) ([34b867f](https://github.com/Mzeey-Emipre/mcode/commit/34b867f60d1e9496c9e65bd9bcacb9ae4840643c))
* add path filter to release-please workflow for manifest changes ([34b867f](https://github.com/Mzeey-Emipre/mcode/commit/34b867f60d1e9496c9e65bd9bcacb9ae4840643c))
* align sidebar and chat header heights ([#75](https://github.com/Mzeey-Emipre/mcode/issues/75)) ([75d12a7](https://github.com/Mzeey-Emipre/mcode/commit/75d12a79474c6af0dd21c96707aceb734d4d79ec))
* async worktree deletion with timeouts and fallback cleanup ([#138](https://github.com/Mzeey-Emipre/mcode/issues/138)) ([c533eb3](https://github.com/Mzeey-Emipre/mcode/commit/c533eb3b3999c5e727ef7dd5ae279f52618a607e))
* capture untracked files in turn snapshots ([#212](https://github.com/Mzeey-Emipre/mcode/issues/212)) ([892f622](https://github.com/Mzeey-Emipre/mcode/commit/892f62240470fc8576cebbd8f525f3b132cc78ad))
* clean up orphaned event listeners in ClaudeProvider resume flow ([#170](https://github.com/Mzeey-Emipre/mcode/issues/170)) ([34c4dfc](https://github.com/Mzeey-Emipre/mcode/commit/34c4dfc11ee5afb3bff8941b254a67766e6512d9))
* clear stale branch data when switching workspaces ([#10](https://github.com/Mzeey-Emipre/mcode/issues/10)) ([f353afd](https://github.com/Mzeey-Emipre/mcode/commit/f353afda3aab1f236216437e93e2ab6cfa34616d))
* clear stale messages on thread switch ([#129](https://github.com/Mzeey-Emipre/mcode/issues/129)) ([5991a99](https://github.com/Mzeey-Emipre/mcode/commit/5991a99dc3c73dc2adc6cc17e1214e183af4102c))
* clear stale tool calls on thread switch and fix dropdown z-index ([#61](https://github.com/Mzeey-Emipre/mcode/issues/61)) ([5480d4c](https://github.com/Mzeey-Emipre/mcode/commit/5480d4c1e4bc02f540fd43bcf900ba733fd9a77a))
* context window calculation inaccuracies ([#207](https://github.com/Mzeey-Emipre/mcode/issues/207)) ([00f0eca](https://github.com/Mzeey-Emipre/mcode/commit/00f0eca89697a9d3c0daafbeaeed95055c4ab531))
* derive worktree folder name from branch name, not thread title ([#117](https://github.com/Mzeey-Emipre/mcode/issues/117)) ([16cb894](https://github.com/Mzeey-Emipre/mcode/commit/16cb8940e7bc80d04b8c9b5bd71061a745c986e8))
* **desktop:** resolve VS Code spawn ENOENT and add in-app error toasts ([#135](https://github.com/Mzeey-Emipre/mcode/issues/135)) ([d3ac59c](https://github.com/Mzeey-Emipre/mcode/commit/d3ac59c52407085218247228262a5b6ca87d8928))
* disallow SDK plan mode tools that Mcode cannot handle ([#197](https://github.com/Mzeey-Emipre/mcode/issues/197)) ([d865be2](https://github.com/Mzeey-Emipre/mcode/commit/d865be2df48dfbde1f050c50eece5da198f27dfe))
* fix token calculation after compaction and add live estimation ([#184](https://github.com/Mzeey-Emipre/mcode/issues/184)) ([253c7c1](https://github.com/Mzeey-Emipre/mcode/commit/253c7c1b85a4711da15959c8ee906adeb9f4bf13))
* format work timer as human-readable duration ([#34](https://github.com/Mzeey-Emipre/mcode/issues/34)) ([38d00b9](https://github.com/Mzeey-Emipre/mcode/commit/38d00b9497dbb56d39375a5170050fd12b6ecc74))
* highlight scroll-to-bottom button instead of auto-scrolling ([#178](https://github.com/Mzeey-Emipre/mcode/issues/178)) ([b2fc80b](https://github.com/Mzeey-Emipre/mcode/commit/b2fc80bc292dbcf9c97790f512ae5865f84f1597))
* live branch indicator updates on external git checkout ([#108](https://github.com/Mzeey-Emipre/mcode/issues/108)) ([#115](https://github.com/Mzeey-Emipre/mcode/issues/115)) ([9c197b2](https://github.com/Mzeey-Emipre/mcode/commit/9c197b2a81a2d372cb2206858a53a34d065bcbe9))
* normalize dated model IDs in picker ([#168](https://github.com/Mzeey-Emipre/mcode/issues/168)) ([9971397](https://github.com/Mzeey-Emipre/mcode/commit/99713976507732a4171daa2bb134a5b2d46bf92e))
* pass image attachments to Codex provider ([#174](https://github.com/Mzeey-Emipre/mcode/issues/174)) ([1fc86a6](https://github.com/Mzeey-Emipre/mcode/commit/1fc86a6af383f2c3c8e5e55cbf1f2322f101045d))
* per-thread model and settings persistence ([#187](https://github.com/Mzeey-Emipre/mcode/issues/187)) ([491d981](https://github.com/Mzeey-Emipre/mcode/commit/491d981edc65123a961e886bb2bc482f89eda439))
* postinstall tar extraction on Windows outside Git Bash ([#72](https://github.com/Mzeey-Emipre/mcode/issues/72)) ([9a43831](https://github.com/Mzeey-Emipre/mcode/commit/9a43831e03c74bccc34cccbb0f1a455693dab147))
* preserve composer draft state per thread on switch ([#76](https://github.com/Mzeey-Emipre/mcode/issues/76)) ([d70a299](https://github.com/Mzeey-Emipre/mcode/commit/d70a29938ec7a1624fa644a3bb4c939ca648a4f3)), closes [#69](https://github.com/Mzeey-Emipre/mcode/issues/69)
* prevent fallback model errors and false fallback detection ([#163](https://github.com/Mzeey-Emipre/mcode/issues/163)) ([3717a63](https://github.com/Mzeey-Emipre/mcode/commit/3717a6320309a7a82009c1ac8b3cfb94fdc4a712))
* prevent fallback model errors when primary and fallback models match ([3717a63](https://github.com/Mzeey-Emipre/mcode/commit/3717a6320309a7a82009c1ac8b3cfb94fdc4a712))
* prevent intermittent tool call drops in chat UI ([#120](https://github.com/Mzeey-Emipre/mcode/issues/120)) ([451a4d3](https://github.com/Mzeey-Emipre/mcode/commit/451a4d39cff709bcfa278902050ed8d6f66c9f4e))
* project deletion confirmation, cleanup, and re-add ([#77](https://github.com/Mzeey-Emipre/mcode/issues/77)) ([9ba5a4f](https://github.com/Mzeey-Emipre/mcode/commit/9ba5a4f08a785429c5183284458109f708e11a63))
* raise UI contrast for WCAG AA accessibility ([#194](https://github.com/Mzeey-Emipre/mcode/issues/194)) ([fad9c2c](https://github.com/Mzeey-Emipre/mcode/commit/fad9c2c669a8a3837adbc1d3ad52510bd24cab9b))
* refresh commits panel in real time on turn.persisted ([#216](https://github.com/Mzeey-Emipre/mcode/issues/216)) ([68e7a3d](https://github.com/Mzeey-Emipre/mcode/commit/68e7a3d6fbfcc9a4709d9f4a26a90900337d09a6))
* render fenced code blocks without language as block elements ([#35](https://github.com/Mzeey-Emipre/mcode/issues/35)) ([a9a1874](https://github.com/Mzeey-Emipre/mcode/commit/a9a18744f48e1eb344e14ac71f9035c73550da32))
* replace deprecated maxThinkingTokens with effort + adaptive thinking ([#160](https://github.com/Mzeey-Emipre/mcode/issues/160)) ([0554836](https://github.com/Mzeey-Emipre/mcode/commit/055483668ee3abdbb48d9ef9505656cfcf326032))
* resolve broken images and better-sqlite3 ABI mismatch ([#79](https://github.com/Mzeey-Emipre/mcode/issues/79)) ([80c82fb](https://github.com/Mzeey-Emipre/mcode/commit/80c82fbae09cc2d0e1248499e311cc3a771eba9c))
* resolve duplicate thread on second Codex message in worktree mode ([#179](https://github.com/Mzeey-Emipre/mcode/issues/179)) ([0df73f2](https://github.com/Mzeey-Emipre/mcode/commit/0df73f2f377ffeb7acf902b385cacbf143013fea))
* resolve EBUSY on Windows worktree cleanup ([#206](https://github.com/Mzeey-Emipre/mcode/issues/206)) ([ce76632](https://github.com/Mzeey-Emipre/mcode/commit/ce766323dd7f2b2482b1f3a5184821f291b07f08))
* resolve Electron binary directly for correct ABI detection ([#73](https://github.com/Mzeey-Emipre/mcode/issues/73)) ([b82b0a1](https://github.com/Mzeey-Emipre/mcode/commit/b82b0a13d648d25f5615cda9fb7df649e228e396))
* resolve v2 session API bugs for multi-turn, cwd, and old thread resume ([#43](https://github.com/Mzeey-Emipre/mcode/issues/43)) ([44bce37](https://github.com/Mzeey-Emipre/mcode/commit/44bce378343a374721848ef9d1457b8bf7cc1875))
* **server:** skip empty text block in attachment-only messages ([#139](https://github.com/Mzeey-Emipre/mcode/issues/139)) ([03a47ad](https://github.com/Mzeey-Emipre/mcode/commit/03a47ad9d5f782e488bd60849346cd8b1321c4cd))
* **server:** stop agent and terminals before worktree removal ([#145](https://github.com/Mzeey-Emipre/mcode/issues/145)) ([e92e9f3](https://github.com/Mzeey-Emipre/mcode/commit/e92e9f32d4514b1d8edb2863fc20903e8f27d7a9))
* set NODE_ENV=production in desktop prod script ([#84](https://github.com/Mzeey-Emipre/mcode/issues/84)) ([fe70323](https://github.com/Mzeey-Emipre/mcode/commit/fe70323d1b96ef7104747ed20cc3697d89932f2f))
* show base branch picker in worktree mode ([#52](https://github.com/Mzeey-Emipre/mcode/issues/52)) ([5f21be9](https://github.com/Mzeey-Emipre/mcode/commit/5f21be9e056934897cfd654b8bc75cab836fa5e4))
* standardize UI on shadcn primitives, eliminate custom elements ([#118](https://github.com/Mzeey-Emipre/mcode/issues/118)) ([8568f0c](https://github.com/Mzeey-Emipre/mcode/commit/8568f0c7f692b47aa4c6fb6d29dcf5e9ced3e9b4))
* support all developer file types in composer paste and drag-drop ([#83](https://github.com/Mzeey-Emipre/mcode/issues/83)) ([406fe6b](https://github.com/Mzeey-Emipre/mcode/commit/406fe6b56dd80b289b9d7151ac8fad640280bcd9))
* sync activeTerminalId on thread switch ([#62](https://github.com/Mzeey-Emipre/mcode/issues/62)) ([d434e34](https://github.com/Mzeey-Emipre/mcode/commit/d434e3446333c837cc7c2299ff073338d614be35))
* terminal copy/paste matches native terminal behaviour ([#116](https://github.com/Mzeey-Emipre/mcode/issues/116)) ([c2d6b1b](https://github.com/Mzeey-Emipre/mcode/commit/c2d6b1b59fb42d20120dce88dff25eed1b3f1602))
* web app silently fails when server is not running ([#80](https://github.com/Mzeey-Emipre/mcode/issues/80)) ([1db94d8](https://github.com/Mzeey-Emipre/mcode/commit/1db94d86e876bb7a29dbea59007a875d263b77e9))
* **web:** align running status color in SubagentContainer ([9a79cdf](https://github.com/Mzeey-Emipre/mcode/commit/9a79cdfe6c414daa8c12327a355a5458ef596264))
* **web:** allow hyphens in branch names and persist composer defaults ([#142](https://github.com/Mzeey-Emipre/mcode/issues/142)) ([e3e8548](https://github.com/Mzeey-Emipre/mcode/commit/e3e8548b5501e7332e5f32002eb5f0bc9e77c07a))
* **web:** correct CSS [@import](https://github.com/import) syntax for Tailwind 4 ([9a79cdf](https://github.com/Mzeey-Emipre/mcode/commit/9a79cdfe6c414daa8c12327a355a5458ef596264))
* **web:** fix StrictMode mountedRef bug in ToolCallSummary ([9a79cdf](https://github.com/Mzeey-Emipre/mcode/commit/9a79cdfe6c414daa8c12327a355a5458ef596264))
* **web:** prevent stale PR icon appearing on unrelated threads ([#161](https://github.com/Mzeey-Emipre/mcode/issues/161)) ([02e296b](https://github.com/Mzeey-Emipre/mcode/commit/02e296b8057ba142dd39d157b6fd0cea436e7987))
* **web:** sanitize custom branch names in worktree creation ([#134](https://github.com/Mzeey-Emipre/mcode/issues/134)) ([0a23f01](https://github.com/Mzeey-Emipre/mcode/commit/0a23f01bad987446815ed3980121b83b589304e2))
* **web:** stabilize clipboard handling in MessageBubble ([9a79cdf](https://github.com/Mzeey-Emipre/mcode/commit/9a79cdfe6c414daa8c12327a355a5458ef596264))
* **web:** sync PR state changes to project tree in realtime ([#143](https://github.com/Mzeey-Emipre/mcode/issues/143)) ([789da6d](https://github.com/Mzeey-Emipre/mcode/commit/789da6d6a0e7bb70c70a3c7a9cb91c1c32b822f3))
* **web:** use block-level container for streaming markdown ([9a79cdf](https://github.com/Mzeey-Emipre/mcode/commit/9a79cdfe6c414daa8c12327a355a5458ef596264))


### Performance Improvements

* cap in-memory message array and add LRU for tool call cache ([#144](https://github.com/Mzeey-Emipre/mcode/issues/144)) ([5248486](https://github.com/Mzeey-Emipre/mcode/commit/524848631efcb37d9fedfea49defaf63ec722294))
* cursor-paginated chat loading with bug fixes ([#149](https://github.com/Mzeey-Emipre/mcode/issues/149)) ([77bd0c4](https://github.com/Mzeey-Emipre/mcode/commit/77bd0c48941774503836015afb5d448816ec07ab))
* cursor-paginated chat loading with infinite scroll ([#146](https://github.com/Mzeey-Emipre/mcode/issues/146)) ([ed3fe6d](https://github.com/Mzeey-Emipre/mcode/commit/ed3fe6db35702b9f16eb834255f4fc4bb328627c))
* **desktop:** V8 startup snapshots for main process ([#141](https://github.com/Mzeey-Emipre/mcode/issues/141)) ([cfaa0a4](https://github.com/Mzeey-Emipre/mcode/commit/cfaa0a4aed3385fc26922c3a1268654a368c8a99))
* electron memory and runtime optimizations ([#127](https://github.com/Mzeey-Emipre/mcode/issues/127)) ([9719c47](https://github.com/Mzeey-Emipre/mcode/commit/9719c4739e2fc7d08ea9f48b4a6ff687078c8d89))
* fix layout thrashing in Composer textarea resize ([#172](https://github.com/Mzeey-Emipre/mcode/issues/172)) ([a76578c](https://github.com/Mzeey-Emipre/mcode/commit/a76578c9d4f51a846cfa8fa54ac38d5b26c43bac))
* lazy-initialize Zod schemas to reduce startup cost ([#159](https://github.com/Mzeey-Emipre/mcode/issues/159)) ([e35732a](https://github.com/Mzeey-Emipre/mcode/commit/e35732adaf0272f2e64a7b05242fc239e911b46e))
* lifecycle-aware memory pressure management ([#123](https://github.com/Mzeey-Emipre/mcode/issues/123)) ([78c84d1](https://github.com/Mzeey-Emipre/mcode/commit/78c84d1990fd86edcd070fc934a15fb257a3ea94))
* memoize MessageBubble and MarkdownContent components ([#60](https://github.com/Mzeey-Emipre/mcode/issues/60)) ([379fed2](https://github.com/Mzeey-Emipre/mcode/commit/379fed26be451974564088a6dd226850fa10e425))
* MessagePort streaming transport and startup flash elimination ([#132](https://github.com/Mzeey-Emipre/mcode/issues/132)) ([d206386](https://github.com/Mzeey-Emipre/mcode/commit/d2063863614fc748c34483d32003b7d21432ba0b))
* migrate from v2 session API to v1 query() with prompt queue ([#59](https://github.com/Mzeey-Emipre/mcode/issues/59)) ([ef1618d](https://github.com/Mzeey-Emipre/mcode/commit/ef1618dec64c367576f987d89090c7662f41e541))
* reduce xterm scrollback and wire settings store ([#171](https://github.com/Mzeey-Emipre/mcode/issues/171)) ([cf62098](https://github.com/Mzeey-Emipre/mcode/commit/cf620984f73acff26c2fc0e8e6deeacbbd23b093))
* stream attachments as binary instead of base64-over-JSON ([#173](https://github.com/Mzeey-Emipre/mcode/issues/173)) ([b3102a1](https://github.com/Mzeey-Emipre/mcode/commit/b3102a1eb7499e4a72de03dd849a6743ac4807ba))
* virtualize chat message list ([#63](https://github.com/Mzeey-Emipre/mcode/issues/63)) ([f223cf7](https://github.com/Mzeey-Emipre/mcode/commit/f223cf7c4f51244a5d789fd7e081afc81dd3f4f1))
* virtualize FileTagPopup file list ([#204](https://github.com/Mzeey-Emipre/mcode/issues/204)) ([de9ee81](https://github.com/Mzeey-Emipre/mcode/commit/de9ee81fddf227204673768d773889fd8a0ee981))


### Code Refactoring

* extract standalone server and replace IPC with WebSocket ([#67](https://github.com/Mzeey-Emipre/mcode/issues/67)) ([ddb4b2f](https://github.com/Mzeey-Emipre/mcode/commit/ddb4b2f1c0395aba4e9b4f1767264dc066905613))
* **web:** extract COMPOSER_MIN_HEIGHT constant ([9a79cdf](https://github.com/Mzeey-Emipre/mcode/commit/9a79cdfe6c414daa8c12327a355a5458ef596264))

## Changelog
