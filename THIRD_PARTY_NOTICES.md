# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).

Its Saunum register map and parser (`src/constants.js` registers, states and
ranges, `src/saunum.js`) are a JavaScript port of parts of **pysaunum**
(<https://github.com/mettolen/pysaunum>, version 0.7.0 and the main branch of
2026-10-15), the Python library of the Saunum integration for Home Assistant:
the Modbus holding registers 0 to 6 (session, sauna type, duration, fan,
setpoint, fan speed, light), 100 to 118 (temperature, on time, heater
elements, door, humidity, session and fan time left, controller state,
AutoLeil, notifications, start-block reasons) and 200 to 205 (alarms), their
ranges (setpoint 40 to 100 °C, duration 60 to 720 / 1080 min), the controller
states, the cooldown rule (a session on with a setpoint of 0), and the
connection advice (500 ms between requests, an idle connection closed by the
panel after 20 s). No Python code runs here and the library is not a
dependency. It carries this license (its LICENSE file names no holder):

```
MIT License

Copyright (c) 2025

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The Modbus TCP client (`src/modbus/client.js`) comes from the integration
gladys-stiebel-eltron of the same author, under the same Apache License 2.0.

The runtime dependency `@gladysassistant/integration-sdk` is installed from
npm with its own license.
