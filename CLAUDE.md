# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
It reads and commands a Saunum Leil sauna control panel over Modbus TCP on the
local network.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run cover                             # cover.png (plain Node)
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/handlers.js                   SDK handlers -> SaunumApp (shared with the tests)
src/app.js                        polling, device, states, status, commands and their guards
src/saunum.js                     registers read and strict parser (pure parser)
src/modbus/client.js              Modbus TCP: one connection, one request at a time, priorities
src/devices.js                    device and states (pure); feature roles are frozen
src/store.js                      /data/saunum-state.json: last read time, sticky stop guard
src/publisher.js                  states to Gladys within 300 per minute
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/i18n.js                       English and French runtime texts
scripts/cover.mjs                 cover.png generator (plain Node, no dependency)
gladys-assistant-integration.json manifest
docs/en.md, docs/fr.md            user documentation (mandatory)
test/                             node --test, against the SDK's fake Gladys and a fake panel
```

## Rules

- **External ids are forever.** `gladys.externalIds('saunum', 'panel')`;
  feature roles (`src/constants.js` FEATURES) and manifest keys never change.
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow**; never edit them by hand.
  `test/manifest.test.js` checks they agree (never a pinned value).
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`.
- **User-facing text** is bilingual and UTF-8 without BOM, without control
  bytes (`test/encoding.test.js`).
- **Saunum.** Turning on and the setpoint stay behind `allow_heating` (off by
  default): a button and a thermostat setpoint, never a switch; decided on a
  fresh read carrying the strict fingerprint of a panel (door closed, no
  alarm, Standby, no start-block reason), checked again right before each
  write, every write within 3.5 s of the click, never above `max_temperature`
  (100 °C at most), duration `session_duration` (720 min at most); a start is
  checked on the reads and turned off when the panel does not keep them.
  Turning off does not depend on the option, a heating command, failed reads
  or the first read; never preceded by a read, PROTECT priority in the Modbus
  queue (cuts a read on the wire), verified by the reads and sent again.
  The exact refusals of each command are in docs/en.md: keep them in step
  with the code. ONE Modbus connection at a time; 1 s between reads, 0.5 s
  before a command. The panel is
  not read sooner than the interval after the last read (kept in `/data`),
  except the reads after a command and every 10 s while a turn off or a start
  is being checked.
  A read for an old configuration publishes nothing (generation checked after
  every await).
