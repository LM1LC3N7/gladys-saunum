# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Saunum Leil sauna control panel over local Modbus TCP: session, state,
  temperature, humidity, door, heater elements, alarm, setpoint, time left,
  light. Never tested with a real device.
- Turn off button, independent of the heating option; turn on button and setpoint behind "Allow
  heating from Gladys" (off by default), refused while the door is open, an
  alarm is on or the panel reports a reason not to start; setpoint capped by
  the configuration (90 °C by default, 100 °C at most), session duration of
  the configuration (60 min by default, 720 at most).
- One Modbus connection at a time, 1 s between reads and 0.5 s before a
  command, turn off before every queued read and command.
- A start from Gladys is checked on the reads (setpoint, duration) and turned
  off when the panel does not keep them; a turn off is verified by the reads
  and sent again when the sauna still heats, with a warning in the status.
- The strict fingerprint of a Saunum panel is required before turning on,
  changing the setpoint or switching the light.
