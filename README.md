# Crash Bash Party

Crash Bash online with friends, in the browser. Pick a character, make a room, send the link, and play through the real Crash Bash mini-games — empty seats are filled by bots.

**Play:** the GitHub Pages link for this repo (Settings → Pages).

- 28 competitive stages across 10 mini-game families: Ballistix, Polar Push, Pogo Painter, Tank Wars, Crate Crush, Crash Dash, Ring Ding, Dragon Drop, Mallet Mash, Keg Kaboom
- Up to 4 players + spectators, peer-to-peer (WebRTC via PeerJS); the host's browser runs the game
- Match settings offer Points Party (4/3/2/1 points per round) or Cup Battle (first to 2–7 cups on one stage, with draws replayed). The host can pick any of the 28 stages.

Move with the arrow keys. Rest your left hand on **Z / X / C / V** for stage actions. Space also performs the main action, and **Q / E** handle turret aim. The rules show each stage’s bindings. Press **Esc** during a round and open **Controls** to see them again. WASD with J / K / L / H and I / O also works. Touchscreens use the on-screen stick and buttons. Hosts can enable custom physics in the lobby with Party Twists.

## Develop

```sh
cd web
npm install
npm run dev          # http://localhost:5173  (LAN mode: ?lan=1 uses the Node server)
npm run test:loopback
npm run build        # static site in web/dist (copies ../assets)
```

Gameplay uses the disc textures and a 512×240 framebuffer displayed at 4:3. Set `HD_TEXTURES=1` for the optional texture pack during development or build.

Assets in `assets/` were extracted from our own disc with the tools in `tools/` (see `docs/`).


## Multiplayer connectivity

GitHub Pages serves the game. PeerJS introduces the browsers, and the host runs the match. Players whose routers allow a direct WebRTC connection can play without a game server. If joining times out, trying a mobile hotspot on one device can change the available route.

For networks that require a TURN relay, set the GitHub Actions repository variable `ICE_SERVERS_URL` and rebuild Pages. For local development use `VITE_ICE_SERVERS_URL`. The HTTPS endpoint must allow requests from the game’s origin and return a JSON array of WebRTC ICE servers with short-lived TURN credentials. The endpoint URL is public in the client build. Keep provider secrets on the credential issuer. The browsers prefer direct connections and can use the relay when needed.
