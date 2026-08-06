# IsleVOIP Overlay

Voice chat overlay for The Isle. An Electron desktop app that runs on top of the
game and provides proximity and group voice, a push-to-talk key, and a small
in-game HUD. It talks to the IsleVOIP relay over WebSockets and authenticates
players through Steam.

## Stack

- Electron main process (`electron/`) — window, Steam login, settings storage,
  global push-to-talk hook (`uiohook-napi`), active-window detection
  (`get-windows`), auto-update (`electron-updater`).
- React + TypeScript renderer (`src/`), bundled with Vite.
- Audio uses the browser WebRTC/WebCodecs stack (Opus); the relay endpoints are
  the public `voip.islepilot.eu` services.

The Steam token is only obtained at runtime from the login flow and stored
encrypted on disk via the OS keychain (`safeStorage`); it is never hardcoded.

## Develop

```bash
npm install
npm run dev        # Vite dev server + Electron
npm run typecheck  # tsc, no emit
```

## Build

```bash
npm run build      # type-check + Vite production build into dist/
npm run dist       # full electron-builder installer
npm run pack       # unpacked build (dir only)
```

## Layout

- `electron/` — Electron main + preload
- `src/` — renderer (React UI, voice engine)
- `scripts/` — build helpers (white-label build, renderer/main obfuscation for
  release installers)
- `build/` — app icons
