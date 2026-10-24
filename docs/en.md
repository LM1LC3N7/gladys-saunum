# Saunum for Gladys

This integration shows a **Saunum Leil sauna** in Gladys, through the Modbus
TCP of its control panel on your local network. **Never tested with a real
device.** Not affiliated with Saunum.

> **Safety.** A sauna gets very hot. Never start heating from afar without
> making sure nobody is inside and nothing lies on the stove. Turning on from
> Gladys is **off by default** and refused while the door is open; turning off
> is never held back by the integration.

## What you get

A sauna in the Discovery tab, with:

- **Session on** (yes/no, read only) and the **state** as text ("Standby",
  "Scheduled", "Heating", "Ready", "Cooling down", "Waiting for the door", with
  ", alarm" when one is on);
- measured **temperature**, **humidity** (newer panel firmware only),
  **door** (opening sensor), **heater elements on**, **alarm** (yes/no);
- the **setpoint** (thermostat) and the **session time left** (minutes, newer
  firmware only);
- the **light** (on/off);
- two buttons: **Turn on (heat)** and **Turn off**.

No switch for the session: an "everything on" from Google Home, Alexa, HomeKit,
MCP or a scene can never start the sauna.

## Setup

1. At the control panel, turn on Modbus TCP and note its IP address (best
   kept fixed in your router).
2. In Gladys, open the Saunum integration, enter the **address** (for example
   `192.168.1.80`, or `192.168.1.80:502`) and, if you changed it, the
   **Modbus unit id** (1 by default).
3. Save, then add the sauna from the **Discovery** tab.
4. To start heating from Gladys, turn on **Allow heating from Gladys**, and
   check the **setpoint of the "Turn on" button** (80 °C by default), the
   **highest setpoint** (90 °C by default, 100 °C at most, the limit of the
   panel) and the **session duration of the "Turn on" button** (60 min by
   default, 60 to 720).

The panel takes **one Modbus connection at a time**: do not use another
Modbus client (Home Assistant, a script) on it at the same time. The
integration itself never opens two connections, waits 500 ms between two
requests (as the Saunum library recommends), and closes its connection after
10 s without a request (the panel would close it at 20 s).

The panel is read every 30 s (10 s to 10 min), **never more often**, even
after a restart, a reconnection to Gladys, the "Test the connection" button or
a Discovery scan; a few seconds after each command, it is read again to show
the result.

There is one panel per integration: the device keeps its id when you change
the address (a new DHCP lease, a replaced panel). The Modbus registers hold no
serial number, so the integration cannot tell two panels apart: change the
address only for the same sauna.

## The commands

- **Turn off** writes "session off" to the panel. It is not held back by the
  option, by a heating command in progress, by failed reads, nor by a restart
  (it works before the first read). It is always written (never "already
  off"), goes before every read or command waiting in the queue (it only waits
  for the request already on the wire and the 0.5 s pause after it), and a heating command
  not written yet gives way to it. It is confirmed by the echo of the panel;
  without an answer within 4.3 s, Gladys shows "Sent, without confirmation".
  It still fails when the panel cannot be reached ("Not sent") or refuses it
  (a Modbus exception): check the sauna then.
- When a start may still land after a turn off (it was sent but not answered),
  every read of the next two minutes that sees the sauna heating writes "off"
  again (3 times at most, kept across a restart). This may also turn off a
  session started at the panel within those two minutes: that is intended.
- **Turn on (heat)** and the **setpoint** are refused while "Allow heating
  from Gladys" is off. On, they read the panel first (never the state in
  memory) and are refused when:
  - the door is open (for the setpoint: while a session is on);
  - an alarm is on, or an alarm register holds an unknown value;
  - the panel reports a reason not to start (newer firmware), or its state is
    not "Standby" (scheduled, waiting for the door, cooling down);
  - a value they need is unknown (setpoint, controller state);
  - a turn off is in flight, waiting, or not confirmed yet; for the setpoint,
    also during the 2 min after a turn off;
  - a previous start is not confirmed yet, or another heating command is in
    progress;
  - the reads and writes cannot all leave within 3.5 s of the click.
    The option and the turn off are checked again right before each write.
- **Turn on** writes the setpoint of the "Turn on" button and the session
  duration of the configuration (when the panel holds other values), then
  starts the session. A session already on: nothing is written.
- **The setpoint** is a whole number from 40 °C to the highest setpoint; it is
  refused while the sauna cools down (it could heat again). With no session
  on, it is kept by the panel, but "Turn on" writes its own setpoint.
- **The light** is a plain on/off, once the panel has been read.

Every command answers within 4.3 s; a write the panel received without
answering in time is "Sent, without confirmation".

## Limits

- Never tested with a real panel: made-up register values only. The register
  map is the one of the pysaunum library (Home Assistant).
- Older firmware without registers 105 to 118: no humidity, no time left, no
  controller state (asked again every 30 minutes).
- Fan, sauna type, AutoLeil and the panel's other settings are not handled.

## Troubleshooting

- "The panel does not answer": check the address, that Modbus TCP is on, and
  that no other Modbus client holds the connection.
- "invalid data": the device at this address does not answer like a Saunum
  panel (a session or door register outside 0/1).
