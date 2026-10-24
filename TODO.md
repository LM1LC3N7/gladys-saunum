# TODO — Saunum v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm run audit`, the store validator, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum topic of its own: the batch reserved in /t/10385 (lot 15) gets one
  recap message there.
- The `gladys-assistant-integration` topic is added at the first real release only.

## Status

- [x] **Milestone 1 — core** (2026-10-24): one panel per integration
      (address + Modbus unit id), reads every interval (never sooner, even
      after a restart), session, state, temperature, humidity, door, heater
      elements, alarm, setpoint, time left, light; turn off never held back
      (PROTECT priority, sticky guard kept in /data when a start may land
      after it); turn on and setpoint behind `allow_heating` (off), decided on
      a fresh read (door closed, no alarm, nothing blocking a start), capped;
      one Modbus connection at a time; test button; docs en/fr; cover. Tested
      against a fake panel only.
- [ ] **Milestone 2 — real panel**: run against a real Saunum Leil (see "To
      check"), turn the answers (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: fan speed and duration, sauna type (preset),
      AutoLeil (humidity mode, interval), close cooldown, dismiss
      notifications, a "sauna ready" scene trigger.

## To check on a real panel

- Whether register 0 stays 1 during the cooldown (pysaunum: "a session on
  with a setpoint of 0"), and what register 109 shows after a turn off.
- Whether the panel accepts a write of the setpoint and the duration while no
  session is on, and keeps them for the next start (turn on relies on it).
- Whether the panel answers a request on the old connection after a new one
  is opened (one connection at a time: what happens to a second client).
- The exception code of an older firmware for registers 105-118 (assumed 2).
- Whether register 0 = 1 starts at once or goes through "waiting for the door".

## Decisions

- **Version 0.1.0** set by hand (package.json, package-lock.json, manifest,
  `docker_image` tag); the Release workflow owns it from now on.
- **Reference**: pysaunum (MIT, LICENSE without a holder name), main branch
  of 2026-10-15 and tag v0.7.0, cloned read-only in `~/code/ref/lot15/pysaunum`.
  Ported: register map, ranges, parser, cooldown rule, timing advice.
- **Modbus client**: the reviewed client of gladys-stiebel-eltron, adapted:
  priorities (turn off, command, read), 500 ms spacing, idle close at 10 s,
  `after` (a new client waits for the previous socket to close), `close()`
  that still runs a queued turn off. No npm dependency.
- **Identity**: `saunum:panel`, one device per integration, frozen. No serial
  number in the registers; plausibility only (session and door registers 0/1,
  else "invalid data", nothing published, no decision).
- **Turn on** writes the setpoint and the session duration of the
  configuration before register 0 = 1 (a register holding 0 would let the
  preset choose, possibly above the cap). Refused unless state is Standby
  (newer firmware) and start-block reasons are 0.
- **Turn off**: no read before it, always written, PROTECT priority (waits
  only for the request on the wire and the 500 ms spacing). Confirmed by the
  echo. A guard when it may have left without answer (lifted by a read
  showing the sauna off) or when a start may land after it (sticky: lifted by
  time only, 2 min, kept in /data, 3 reaffirmations at most). The /data write
  of the sticky guard is not awaited before the turn off (a failing disk never
  delays it).
- **Light**: a plain write (not behind the option), refused before a
  successful read.
- **Clocks**: deadlines, guards and intervals on a monotonic clock; /data on
  the wall clock.
- **Polling interval**: 30 s by default (10 s – 10 min); the connection is not
  kept alive between reads (closed at 10 s idle).
