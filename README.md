# gladys-saunum

[Gladys Assistant](https://gladysassistant.com) external integration for
**Saunum Leil sauna control panels**, over Modbus TCP on the local network:
session, state, temperature, humidity, door, heater elements, alarm, setpoint,
time left, light; turn off never held back; turning on and the setpoint behind
an off-by-default option, refused while the door is open or an alarm is on.
**Never tested with a real device. Not affiliated with Saunum.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (SaunumApp)
                                  ├─ src/saunum.js        registers read, strict parser (pure)
                                  ├─ src/modbus/client.js Modbus TCP: one connection, one request at a time, by priority
                                  ├─ src/devices.js       the device and its states (pure)
                                  ├─ src/publisher.js     states within 300/min
                                  └─ src/store.js         /data/saunum-state.json (no secret)
```

- **Protocol**: Modbus TCP (port 502, unit 1, no authentication), holding
  registers 0-6, 100-104 (100-118 on newer firmware) and 200-205, as the
  `pysaunum` Python library (MIT, mettolen/pysaunum, the library of Home
  Assistant's Saunum integration) reads and writes them.
- **One connection at a time**: one socket per client, a new address waits
  until the previous connection is closed; 500 ms between requests; closed
  after 10 s idle (the panel closes at 20 s).
- **Identity**: one device per integration, `saunum:panel` (frozen). The
  registers carry no serial number.
- **Reads**: every 30 s (10 s – 10 min), never sooner than the interval after
  the last one (time kept in `/data`, written before the read, at most once a
  minute). A read where the session or door register is not 0/1 is refused
  as a whole ("invalid data").
- **Commands**: turn off = one write of register 0 = 0, PROTECT priority
  (before every queued read and command), never held back; turn on (setpoint
  and duration of the configuration, then register 0 = 1) and setpoint behind
  `allow_heating` (off), decided on a fresh read, checked again before each
  write, all writes within 3.5 s of the click. See [docs/en.md](docs/en.md)
  for the exact refusals.

## Development

```bash
npm install
npm run format:check && npm run lint && npm test
npm run cover        # cover.png
```

Tests run against the SDK's fake Gladys and a fake panel (`test/fixtures/fakePanel.js`),
never the network.

## License

Apache-2.0 (see `LICENSE`); third-party notices in `THIRD_PARTY_NOTICES.md`.
