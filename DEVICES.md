# Devices

A **device** is hardware that connects itself to Clavarium with its own key: a voice box in a
room, later a kiosk tablet. Its program, its firmware, lives outside Clavarium, in a repository
of its own (GitHub topic `clavarium-device`). Clavarium knows only the protocol below, so
anyone can build another device that speaks it.

Pairing codes are made in Access › Devices › Voice boxes, or by the page when an assistant
flashes a device through Tether (`device-flash` with `pair`). What a box hears is said in its
conversation as the person's message, the room named; what the assistant then says is read
aloud on this server (an open French voice, nothing sent elsewhere) and played by the box.

The endpoints are under `/c/`: the edge lets a device through without signing in, and the code,
then the key, is the right.

## Voice box protocol, v1

Between a box and Clavarium. Everything goes over HTTPS / WSS; the box trusts the usual public
roots (ESP-IDF's certificate bundle).

### Pairing

`POST {clavarium}/c/api/box/pair`

```json
{ "code": "K7Q2-M9PX", "room": "Living room", "type": "voice-box/1", "firmware": "0.1.0",
  "capabilities": ["mic", "speaker", "led-ring:7", "button", "mute", "wifi", "ble"] }
```

- `200` `{ "id": "<uuid>", "key": "<secret, 43 characters>", "name": "Living room" }`: the key is given once.
- `403`: unknown or expired code. `429`: too many tries.

The code comes from Clavarium (8 characters, valid 10 minutes).

### Connection

`wss://{clavarium}/c/api/box/ws` with `Authorization: Bearer <key>`.

- `401`: the key was withdrawn. The box forgets its settings and goes back to setup.
- Connection lost: the box reconnects by itself after 1, 2, 4… up to 60 seconds, showing "offline" meanwhile.

Text frames carry one JSON object each, with its type in `t`. Binary frames carry audio:
**PCM 16 kHz, 16-bit, mono, little-endian**, in 20 ms pieces (640 bytes).

#### Box → Clavarium

| `t` | Fields | When |
|---|---|---|
| `hello` | `firmware`, `capabilities`, `rssi`, `volume`, `muted` | on every connection |
| `listen.start` | `reason`: `button` \| `wake` | a sentence begins; binary frames follow |
| `listen.end` | `reason`: `silence` \| `button` \| `timeout` (15 s at most) | the sentence ends |
| `event` | `name`: `button` (+`alert`), `button.long`, `mute.on`, `mute.off`, `battery` (+`level`), `error` (+`detail`) | when it happens |
| `wifi.scan.result` | `id`, `networks`: [{`ssid`, `rssi`, `secure`}] | answers `wifi.scan` |
| `ack` | `id`, `ok`, `detail`? | answers any command that has an `id` |
| `ping` | — | every 30 s |

#### Clavarium → box

| `t` | Fields | Effect |
|---|---|---|
| `cue` | `name`: `thinking` \| `error` \| `done` | plays the cue and shows the state |
| `speak.start` | `rate`: 16000 | binary frames follow, played as they come |
| `speak.end` | — | the answer is complete; back to idle once played |
| `alert` | `id`, `text`? | chimes (3 times at most), orange until a press; then `event` `button` and `ack` |
| `led` | `id`, `pattern`: `off` \| `solid` \| `pulse` \| `spin`, `color`: `#RRGGBB` | the ring |
| `volume` | `id`, `level`: 0-100 | the volume, kept |
| `wifi.scan` | `id` | answered with `wifi.scan.result` |
| `wifi.join` | `id`, `ssid`, `password` | tries it, keeps the old one if it fails; `ack` once back online |
| `reboot` | `id` | restarts after its `ack` |
| `ota` | `id`, `url`, `sha256` | downloads, checks, installs, restarts |
| `pong` | — | answers `ping` |

An unknown command with an `id` gets `ack` `ok: false`, `detail: "unknown"`; anything unexpected
is ignored, never fatal.

### Privacy

Nothing leaves the microphone outside a sentence, and nothing is recorded on the box. Mute stops
the microphone. The Wi-Fi password and the key stay in the box's storage: never logged, never sent back.

### Over the USB cable: Improv

Right after a browser flash, the same page gives the box its Wi-Fi over the cable: Improv Wi-Fi,
serial version 1 (improv-wifi.com), on the box's own USB port, beside its log lines. Supported:
the commands 1 (Wi-Fi), 2 (state), 3 (device information) and 4 (scan). One more, ours:

| Command | Strings | Effect |
|---|---|---|
| `0xC0` | Clavarium's address, the room, a pairing code | kept until the next Wi-Fi command, which then pairs too |

A refused pairing is the error `0x80`. Once provisioned, the box restarts, connected.
