# Crash Bash Party

Crash Bash online with friends, in the browser. Pick a character, make a room, send the link, and play through the real Crash Bash mini-games — empty seats are filled by bots.

**Play:** the GitHub Pages link for this repo (Settings → Pages).

- 10 mini-games on their real stages: Ballistix, Polar Push, Pogo Painter, Tank Wars, Crate Crush, Crash Dash, Ring Ding, Dragon Drop, Mallet Mash, Keg Kaboom
- Up to 4 players + spectators, peer-to-peer (WebRTC via PeerJS); the host's browser runs the game
- Points per round (4/3/2/1, double on the last round), trophies, comeback bonus, podium

Controls: WASD / arrows to move, Space = action, Shift = secondary. Gamepad and touch supported.

## Develop

```sh
cd web
npm install
npm run dev          # http://localhost:5173  (LAN mode: ?lan=1 uses the Node server)
npm run test:loopback
npm run build        # static site in web/dist (copies ../assets)
```

Assets in `assets/` were extracted from our own disc with the tools in `tools/` (see `docs/`).
