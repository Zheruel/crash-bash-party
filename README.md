# Crash Bash Party

Crash Bash online with friends, in the browser. Pick a character, make a room, send the link, and play through the real Crash Bash mini-games — empty seats are filled by bots.

**Play:** the GitHub Pages link for this repo (Settings → Pages).

- 10 mini-games on their real stages: Ballistix, Polar Push, Pogo Painter, Tank Wars, Crate Crush, Crash Dash, Ring Ding, Dragon Drop, Mallet Mash, Keg Kaboom
- Up to 4 players + spectators, peer-to-peer (WebRTC via PeerJS); the host's browser runs the game
- Points per round (4/3/2/1, double on the last round), trophies, comeback bonus, podium

Controls: WASD / arrows to move, Space (or J) = action, Shift (or K) = secondary, F (or L) = third button, Q / E = Tank Wars turret. Each game's intro card shows its keys. Gamepad and touch supported.

## Develop

```sh
cd web
npm install
npm run dev          # http://localhost:5173  (LAN mode: ?lan=1 uses the Node server)
npm run test:loopback
npm run build        # static site in web/dist (copies ../assets)
```

Assets in `assets/` were extracted from our own disc with the tools in `tools/` (see `docs/`).


## Multiplayer connectivity

GitHub Pages serves the game. PeerJS introduces the browsers, and the host runs the match. Players whose routers allow a direct WebRTC connection can play without a game server. If joining times out, trying a mobile hotspot on one device can change the available route.

For networks that require a TURN relay, set the GitHub Actions repository variable `ICE_SERVERS_URL` and rebuild Pages. For local development use `VITE_ICE_SERVERS_URL`. The HTTPS endpoint must allow requests from the game’s origin and return a JSON array of WebRTC ICE servers with short-lived TURN credentials. The endpoint URL is public in the client build. Keep provider secrets on the credential issuer. The browsers prefer direct connections and can use the relay when needed.
