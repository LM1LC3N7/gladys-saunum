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
      elements, alarm, setpoint, time left, light; turn off independent of the
      option (PROTECT priority, sticky guard kept in /data when a start may land
      after it); turn on and setpoint behind `allow_heating` (off), decided on
      a fresh read (door closed, no alarm, nothing blocking a start), capped;
      one Modbus connection at a time; test button; docs en/fr; cover. Tested
      against a fake panel only.
- [x] **Review 1 fixes** (2026-10-24), tests in `test/review1.test.js` and
      `test/client.test.js`: B1 a start checked on the reads (setpoint not 0
      and within the cap, duration written, register 106 and time left on a
      newer firmware), turned off with a warning otherwise or when no read
      checks it within 1 min. I2 strict fingerprint before turn on, setpoint
      and light; a newer panel refusing 105-118 is not downgraded (heating
      refused). I3 a connection being opened is destroyed and awaited by
      `close()`; a new connection waits for every socket of the client to
      close; an unused connection gets the idle timer. I4 "not sent yet" when
      the turn off has not left at 4.3 s; a read on the wire is cut for a turn
      off. I5 a guard after every turn off, lifted by a read showing the sauna
      off, else sent again (3 at most) with a warning. I6 a read every 10 s
      while a guard or a start check is pending (restored from /data too). I7
      only the states of a read applied in the round are published. I8 the
      setpoint follows register 109. I9 the configuration loaded again (5, 15,
      30, then 60 s); a command arriving before waits for it within 3.5 s. I10
      docs, manifest, README, CLAUDE.md: no false absolute, the refusals of
      each command. M11 a start too slow for 3.5 s is refused before the first
      write. M12 a turn off during an address change goes to the new address.
      M13 one connection "may" (unverified), pysaunum spacing: 1 s between
      reads, 0.5 s before a command. M14 a true reason for an invalid unit; a
      turn off refused by a busy panel (exception 5/6) tried once more. M15
      dead code removed.
- [x] **Review 2 fixes** (2026-10-24): I1 the time estimate before a start
      uses the longest answer time measured on the fresh read (no double
      spacing): now + 0.5 s + (writes − 1) × (answer + 0.5 s), own reason. M2 a
      read connecting while a turn off waits gives way (nothing sent). M3 "the
      panel did not start the session" when the reads show it off. M4 a sticky
      guard is extended only by a new start that may land. M5 the start check
      uses the current highest setpoint. M6 only a duration of 0 or longer than
      written turns off. M7 fingerprint: session duration 0-1080. M8 texts.
- [x] **Review 3 minors** (2026-10-24, approved): M1 a turn off ends the
      check of a start (no second turn off nor false warning). M2 the fresh
      read returns the answer times of its own requests (no shared field).
      M3 test at 100-150 ms with 3 writes; slow-panel workaround documented.
      M5 docs: the turn off also waits for a connection being opened.
- [ ] **Review 3, minor 4 (open)**: a non-sticky turn off during a sticky
      guard is verified only for the time left of that guard; at the end of
      the sticky part, continue as a non-sticky guard until a read shows the
      sauna off.
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
- **Turn off**: no read before it, always written, PROTECT priority (cuts a
  read on the wire; waits only for a write on the wire and the 500 ms
  spacing). Accepted on the echo, verified by the reads: a guard after every
  turn off, lifted by a read showing the sauna off; sticky (time only, 2 min,
  kept in /data) when a start may land after it; 3 reaffirmations at most,
  with a warning. The /data write of the sticky guard is not awaited before
  the turn off (a failing disk does not delay it).
- **Start check** (review 1): the panel keeping the setpoint and duration
  written before register 0 = 1 is unverified; every read while a session
  started from Gladys may run checks them (kept in /data), and the sauna is
  turned off otherwise, or when nothing could be read within 1 min. A
  duration of 0 or longer than written, set at the panel during that session,
  also turns it off (shorter is accepted); the setpoint is compared with the
  highest setpoint of the configuration as it is now.
- **Spacing**: 1 s between reads (pysaunum recommendation), 0.5 s before a
  command (pysaunum minimum): a turn on is up to 4 reads and 3 writes within
  3.5 s.
- **Fingerprint** (review 1): sauna type 0-31 (pysaunum: device-dependent),
  fan duration 0-30 (pysaunum 0.7.0; 0-20 on its main branch), the other
  ranges as pysaunum documents them.
- **Light**: a plain write (not behind the option), refused before a
  successful read.
- **Clocks**: deadlines, guards and intervals on a monotonic clock; /data on
  the wall clock.
- **Polling interval**: 30 s by default (10 s – 10 min); the connection is not
  kept alive between reads (closed at 10 s idle).
