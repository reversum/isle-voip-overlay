import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OverlaySettings } from "./types";
import { VoiceEngine, type InputMode } from "./voice/engine";
import { MicMonitor, type MonitorOpts } from "./voice/mic-monitor";
import type { ConnState, Participant, ServerInfo } from "./voice/types";

type Phase = "spin" | "title" | "app";
type View = "home" | "servers" | "mode" | "groups" | "voice";
type GroupInfo = { name: string; memberCount: number; hasPassword: boolean };

const MOUSE_CODE: Record<number, string> = { 1: "Mouse3", 3: "Mouse4", 4: "Mouse5" };
const mouseCode = (button: number): string | null => MOUSE_CODE[button] ?? null;

const bridge = () => window.isleVoip;
const OWNER_SID = "76561198886320664";
const isPremium = (tier: string) => tier === "premium" || tier === "ultra";

const CHANGELOG_SEEN_KEY = "isleVoipChangelogSeen";
const CHANGELOG: { version: string; items: string[] }[] = [
  {
    version: "0.2.3",
    items: [
      "Fixed voice connections dying silently after short network hiccups - they now recover on their own within seconds",
      "Fixed hearing some people but not others after playing for a while: stuck peer connections are detected and rebuilt automatically",
      "Fixed the microphone going dead when Windows switches audio devices (default device change, Bluetooth headset reconnect)",
      "Fixed frozen position updates that silently stopped nearby players from being connected",
      "Fixed all audio going silent after an audio device change",
      "Leaving and rejoining a server to fix your voice should no longer be needed",
      "Added this changelog popup and a bug report button in the top bar",
    ],
  },
];

const playTestTone = async (deviceId: string | null): Promise<void> => {
  const ctx = new AudioContext();
  try {
    if (deviceId) {
      const sink = ctx as unknown as { setSinkId?: (id: string) => Promise<void> };
      if (sink.setSinkId) {
        try {
          await sink.setSinkId(deviceId);
        } catch {
        }
      }
    }
    if (ctx.state === "suspended") await ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 660;
    gain.gain.value = 0.18;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
    await new Promise((r) => setTimeout(r, 550));
  } finally {
    try {
      await ctx.close();
    } catch {
    }
  }
};

export const App = () => {
  const [phase, setPhase] = useState<Phase>("spin");
  const spins = useMemo(() => 3 + Math.floor(Math.random() * 3), []);

  useEffect(() => {
    const perSpin = 700;
    const toTitle = window.setTimeout(() => setPhase("title"), spins * perSpin);
    const toApp = window.setTimeout(() => setPhase("app"), spins * perSpin + 1200);
    return () => {
      window.clearTimeout(toTitle);
      window.clearTimeout(toApp);
    };
  }, [spins]);

  if (phase !== "app") {
    return (
      <div className="splash">
        {phase === "spin" ? (
          <i
            className="fa-solid fa-hourglass-half splashGlass"
            style={{ animationIterationCount: spins }}
            aria-hidden="true"
          />
        ) : (
          <div className="splashTitle">
            Isle<span>VOIP</span>
          </div>
        )}
      </div>
    );
  }

  return <MainApp />;
};

const MainApp = () => {
  const engineRef = useRef<VoiceEngine | null>(null);
  const monitorRef = useRef<MicMonitor>(new MicMonitor());
  const [settings, setSettings] = useState<OverlaySettings | null>(null);
  const [steamId, setSteamId] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [whitelabel, setWhitelabel] = useState<{
    serverHash: string;
    serverLabel?: string;
    tier?: string;
    appName?: string;
  } | null>(null);
  const [linkedServers, setLinkedServers] = useState<Array<{ hash: string; label: string }>>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [selfIngame, setSelfIngame] = useState(false);
  const [status, setStatus] = useState<{ voice: ConnState; listen: ConnState }>({
    voice: "idle",
    listen: "idle",
  });
  const [connected, setConnected] = useState(false);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [bugOpen, setBugOpen] = useState(false);
  const [devOpen, setDevOpen] = useState(false);
  const [pushMuted, setPushMuted] = useState(false);
  const [globalKeys, setGlobalKeys] = useState(false);
  const [view, setView] = useState<View>("home");
  const [selectedServer, setSelectedServer] = useState<ServerInfo | null>(null);
  const [myNick, setMyNick] = useState("");
  const [selectedChannel, setSelectedChannel] = useState("prox");
  const [groupsList, setGroupsList] = useState<GroupInfo[]>([]);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupPw, setNewGroupPw] = useState("");
  const [joinName, setJoinName] = useState<string | null>(null);
  const [joinPw, setJoinPw] = useState("");
  const [updater, setUpdater] = useState<UpdaterState>({ state: "idle" });
  const [updateRequired, setUpdateRequired] = useState(false);
  const capturingRef = useRef(false);

  const canBridge = Boolean(bridge());

  const patchSettings = useCallback(async (patch: Partial<OverlaySettings>) => {
    const b = bridge();
    if (!b) return undefined;
    const saved = await b.setSettings(patch);
    setSettings(saved);
    return saved;
  }, []);

  const monitorOpts = (over?: Partial<MonitorOpts>): MonitorOpts => ({
    deviceId: settings?.micDeviceId ?? null,
    outputDeviceId: settings?.outputDeviceId ?? null,
    inputVolume: settings?.inputVolume ?? 1,
    noiseSuppression: settings?.noiseSuppression ?? false,
    autoGainControl: settings?.autoGainControl ?? false,
    ...over,
  });

  useEffect(() => () => void monitorRef.current.stop(), []);

  useEffect(() => {
    if (window.localStorage.getItem(CHANGELOG_SEEN_KEY) !== __APP_VERSION__) {
      setChangelogOpen(true);
    }
  }, []);

  const closeChangelog = useCallback(() => {
    window.localStorage.setItem(CHANGELOG_SEEN_KEY, __APP_VERSION__);
    setChangelogOpen(false);
  }, []);

  useEffect(() => {
    const b = bridge();
    if (!b) return;
    (async () => {
      try {
        setSettings(await b.getSettings());
        const auth = await b.getAuth();
        setSteamId(auth?.steamId ?? null);
      } catch {
      }
    })();
    b.onAuthChanged((p) => setSteamId(p?.steamId ?? null));
    if (b.updaterGetState) {
      void b.updaterGetState().then((s) => s && setUpdater(s));
      return b.onUpdaterEvent((s) => setUpdater(s));
    }
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch {
    }
    const list = await navigator.mediaDevices.enumerateDevices();
    setDevices(list.filter((d) => d.kind === "audioinput"));
    setOutputDevices(list.filter((d) => d.kind === "audiooutput"));
  }, []);

  useEffect(() => {
    if (!whitelabel) {
      setLinkedServers([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await bridge()?.listLinkedServers?.(whitelabel.serverHash);
      if (cancelled) return;
      setLinkedServers(res?.servers ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [whitelabel]);

  const refreshServers = useCallback(async () => {
    const b = bridge();
    if (!b) return;
    const res = await b.listServers();
    setServers(res.servers ?? []);
    if (res.error) setError(res.error);
  }, []);

  useEffect(() => {
    void refreshDevices();
    void refreshServers();
  }, [refreshDevices, refreshServers]);

  const onLogin = async () => {
    const b = bridge();
    if (!b) return;
    setBusy(true);
    try {
      const res = await b.steamLogin();
      if (res?.steamId) setSteamId(res.steamId);
    } finally {
      setBusy(false);
    }
  };

  const onLogout = async () => {
    const b = bridge();
    if (!b) return;
    await b.logout();
    setSteamId(null);
  };

  const connectTo = async (server: ServerInfo, channel = "prox", groupPassword?: string) => {
    const b = bridge();
    if (!b || !settings) return;
    setError(null);
    setBusy(true);
    try {
      const ticket = await b.getVoiceTicket();
      if ("error" in ticket) {
        setError(`Ticket: ${ticket.error}`);
        return;
      }
      const engine = new VoiceEngine();
      engine.onParticipants = (list) => setParticipants(list);
      engine.onSelfIngame = (v) => setSelfIngame(v);
      engine.onStatus = (s) => setStatus(s);
      engine.onError = (e) => {
        if (e === "update_required") {
          setUpdateRequired(true);
          void bridge()?.updaterCheck?.();
        }
        const msg =
          e === "update_required"
            ? "This version is outdated. Update required."
            : e === "bad_password"
              ? "Wrong group password."
              : e === "groups_disabled"
                ? "Groups are disabled on this server."
                : e === "group_full"
                  ? "This group is full."
                  : e === "group_limit"
                    ? "This server reached its group limit."
                    : `Voice: ${e}`;
        setError(msg);
        engineRef.current?.disconnect();
        engineRef.current = null;
        setConnected(false);
        setParticipants([]);
        setSelfIngame(false);
        setView(channel === "prox" ? (whitelabel ? "home" : "servers") : "groups");
      };
      engineRef.current = engine;
      await engine.connect({
        centralUrl: settings.centralUrl,
        hash: server.hash,
        nameMode: server.nameMode,
        hideNearby: server.hideNearby,
        ticket: ticket.ticket,
        mySid: ticket.steamId64,
        micDeviceId: settings.micDeviceId,
        outputDeviceId: settings.outputDeviceId,
        inputMode: settings.inputMode as InputMode,
        masterVolume: settings.outputVolume,
        inputVolume: settings.inputVolume,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl,
        vadThreshold: settings.vadThreshold,
        channel,
        groupPassword,
        getTicket: () => b.getVoiceTicket(),
      });
      engine.setMuted(muted);
      setSelectedChannel(channel);
      setConnected(true);
      setView("voice");
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      let msg = String(err instanceof Error ? err.message : err);
      if (name === "NotAllowedError" || name === "SecurityError")
        msg = "Microphone access blocked. Allow it in Windows privacy settings, then retry.";
      else if (name === "NotFoundError" || name === "OverconstrainedError")
        msg = "No usable microphone found. Pick a specific mic in Settings (not just Default).";
      else if (name === "NotReadableError")
        msg = "Microphone is busy in another app. Close it (or pick another mic in Settings), then retry.";
      setError(msg);
      engineRef.current?.disconnect();
      engineRef.current = null;
    } finally {
      setBusy(false);
    }
  };

  const refreshGroups = useCallback(async () => {
    const b = bridge();
    if (!b || !selectedServer) return;
    const res = await b.listGroups(selectedServer.hash);
    setGroupsList(res.groups ?? []);
    if (res.error) setError(res.error);
  }, [selectedServer]);

  const onJoinGroup = (g: GroupInfo) => {
    if (!selectedServer) return;
    if (g.hasPassword) {
      setJoinName(g.name);
      setJoinPw("");
    } else {
      void connectTo(selectedServer, g.name);
    }
  };

  const openServer = async (server: ServerInfo) => {
    const b = bridge();
    if (!b) return;
    setError(null);
    let sid = steamId;
    if (!sid) {
      setBusy(true);
      try {
        const res = await b.steamLogin();
        sid = res?.steamId ?? null;
        if (sid) setSteamId(sid);
      } finally {
        setBusy(false);
      }
    }
    if (!sid) {
      setError("Steam sign-in is required to join a server.");
      return;
    }
    setSelectedServer(server);
    if (isPremium(server.tier)) {
      setView("mode");
    } else {
      await connectTo(server);
    }
  };

  const connectWhitelabelHash = async (hash: string, label: string) => {
    let list = servers;
    if (list.length === 0) {
      const res = await bridge()?.listServers();
      list = res?.servers ?? [];
      setServers(list);
    }
    const found = list.find((s) => s.hash === hash);
    const server: ServerInfo = found ?? {
      hash,
      label,
      tier: whitelabel?.tier || "premium",
      serverIp: null,
      online: false,
      playerCount: 0,
      groupsEnabled: true,
    };
    await openServer(server);
  };

  const connectWhitelabel = async () => {
    if (!whitelabel) return;
    await connectWhitelabelHash(
      whitelabel.serverHash,
      whitelabel.serverLabel || whitelabel.appName || "Server",
    );
  };

  const leave = () => {
    const wasGroup = selectedChannel !== "prox";
    engineRef.current?.disconnect();
    engineRef.current = null;
    setConnected(false);
    setParticipants([]);
    setSelfIngame(false);
    setStatus({ voice: "idle", listen: "idle" });
    setSelectedChannel("prox");
    if (wasGroup && selectedServer) {
      setView("groups");
      void refreshGroups();
    } else if (selectedServer && isPremium(selectedServer.tier)) {
      setView("mode");
    } else {
      setView(whitelabel ? "home" : "servers");
    }
  };

  useEffect(() => () => engineRef.current?.disconnect(), []);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      engineRef.current?.setMuted(next);
      return next;
    });
  }, []);

  useEffect(() => {
    bridge()
      ?.globalKeysActive?.()
      .then((v) => setGlobalKeys(Boolean(v)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    bridge()
      ?.getWhitelabel?.()
      .then((wl) => setWhitelabel(wl ?? null))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!settings) return;
    const held = new Set<string>();
    const onDown = (code: string) => {
      if (capturingRef.current) return;
      const firstDown = !held.has(code);
      held.add(code);
      if (settings.inputMode === "ptt" && code === settings.pttKey) engineRef.current?.setPttActive(true);
      if (settings.pushToMuteKey && code === settings.pushToMuteKey) {
        engineRef.current?.setPushMute(true);
        setPushMuted(true);
      }
      if (settings.toggleMuteKey && code === settings.toggleMuteKey && firstDown) toggleMute();
    };
    const onUp = (code: string) => {
      held.delete(code);
      if (settings.inputMode === "ptt" && code === settings.pttKey) engineRef.current?.setPttActive(false);
      if (settings.pushToMuteKey && code === settings.pushToMuteKey) {
        engineRef.current?.setPushMute(false);
        setPushMuted(false);
      }
    };

    const offGlobal = globalKeys
      ? bridge()?.onGlobalKey((p) => (p.type === "down" ? onDown(p.code) : onUp(p.code)))
      : undefined;
    const kd = (e: KeyboardEvent) => onDown(e.code);
    const ku = (e: KeyboardEvent) => onUp(e.code);
    const md = (e: MouseEvent) => {
      const c = mouseCode(e.button);
      if (c) onDown(c);
    };
    const mu = (e: MouseEvent) => {
      const c = mouseCode(e.button);
      if (c) onUp(c);
    };
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("mousedown", md);
    window.addEventListener("mouseup", mu);
    return () => {
      offGlobal?.();
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      window.removeEventListener("mousedown", md);
      window.removeEventListener("mouseup", mu);
    };
  }, [settings, toggleMute, globalKeys]);

  const effMuted = muted || pushMuted;

  return (
    <div className="app">
      <header className="appHeader">
        <div
          className="wordmark"
          style={{ cursor: connected ? "default" : "pointer" }}
          onClick={() => {
            if (!connected) setView("home");
          }}
        >
          Isle<span>VOIP</span>
          <span className="appVersion">v{__APP_VERSION__}</span>
        </div>
        <div className="headerRight">
          {connected ? (
            <>
              <StatusChip label="Voice" state={status.voice} />
              <StatusChip label="Position" state={status.listen} />
            </>
          ) : null}
          {steamId ? (
            <div className="authMini" title={steamId}>
              <i className="fa-brands fa-steam" aria-hidden="true" />
              <span>{steamId}</span>
              <button className="btn btnSmall btn-ghost" onClick={() => void onLogout()}>
                <i className="fa-solid fa-right-from-bracket" aria-hidden="true" /> Logout
              </button>
            </div>
          ) : (
            <button className="btn btn-steam btnSmall" onClick={() => void onLogin()} disabled={busy || !canBridge}>
              <i className="fa-brands fa-steam" aria-hidden="true" /> Sign in with Steam
            </button>
          )}
          <button className="btn btnSmall btn-ghost" onClick={() => setBugOpen(true)} title="Report a bug">
            <i className="fa-solid fa-bug" aria-hidden="true" />
          </button>
          <button className="btn btnSmall btn-ghost" onClick={() => setChangelogOpen(true)} title="Changelog">
            <i className="fa-solid fa-clipboard-list" aria-hidden="true" />
          </button>
          <button className="btn btnSmall btn-ghost" onClick={() => setSettingsOpen(true)} title="Settings">
            <i className="fa-solid fa-gear" aria-hidden="true" />
          </button>
          {steamId === OWNER_SID ? (
            <button className="btn btnSmall btn-ghost" onClick={() => setDevOpen(true)} title="Developer settings">
              <i className="fa-solid fa-flask" aria-hidden="true" /> Dev
            </button>
          ) : null}
          <div className="winCtrls">
            <button className="winBtn" onClick={() => bridge()?.minimizeWindow?.()} title="Minimize" aria-label="Minimize">
              <i className="fa-solid fa-minus" aria-hidden="true" />
            </button>
            <button className="winBtn" onClick={() => bridge()?.maximizeToggle?.()} title="Maximize" aria-label="Maximize">
              <i className="fa-regular fa-square" aria-hidden="true" />
            </button>
            <button className="winBtn winClose" onClick={() => bridge()?.closeWindow?.()} title="Close" aria-label="Close">
              <i className="fa-solid fa-xmark" aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      {!canBridge ? (
        <div className="banner bannerWarn">Only available in the Electron app, not in a plain browser.</div>
      ) : null}
      {error ? (
        <div className="banner bannerErr">
          <i className="fa-solid fa-triangle-exclamation" aria-hidden="true" /> {error}
        </div>
      ) : null}
      {!updateRequired && updater.state === "downloaded" ? (
        <div className="banner bannerWarn">
          <i className="fa-solid fa-circle-up" aria-hidden="true" /> Update {updater.version ? `v${updater.version} ` : ""}
          ready.
          <button className="btn btnSmall" onClick={() => void bridge()?.updaterRestart?.()}>
            <i className="fa-solid fa-rotate-right" aria-hidden="true" /> Restart now
          </button>
        </div>
      ) : null}

      {updateRequired ? (
        <div className="updateBlocker" role="alertdialog" aria-modal="true">
          <div className="updateBlockerCard">
            <i className="fa-solid fa-circle-up updateBlockerIcon" aria-hidden="true" />
            <div className="updateBlockerTitle">Update required</div>
            <div className="updateBlockerText">
              Your version (v{__APP_VERSION__}) is too old to connect. Everyone must be on the same version for voice to
              work.
            </div>
            <div className="updateBlockerStatus">
              {updater.state === "downloaded"
                ? `Update ${updater.version ? `v${updater.version} ` : ""}downloaded.`
                : updater.state === "downloading"
                  ? `Downloading update… ${updater.percent ?? 0}%`
                  : updater.state === "error"
                    ? `Update failed: ${updater.message ?? "unknown error"}. Reinstall from the download page.`
                    : "Checking for update…"}
            </div>
            {updater.state === "downloaded" ? (
              <button className="btn" onClick={() => void bridge()?.updaterRestart?.()}>
                <i className="fa-solid fa-rotate-right" aria-hidden="true" /> Restart and update
              </button>
            ) : (
              <button className="btn btn-ghost" onClick={() => void bridge()?.updaterCheck?.()}>
                <i className="fa-solid fa-magnifying-glass" aria-hidden="true" /> Check again
              </button>
            )}
          </div>
        </div>
      ) : null}

      {view === "home" ? (
        <div className="homeWrap">
          <div className="homeStack">
          <div className={whitelabel && linkedServers.length > 1 ? "homeGrid" : "homeGrid homeGridSingle"}>
            {whitelabel && linkedServers.length > 1 ? (
              linkedServers.map((s, i) => (
                <button
                  key={s.hash}
                  className="homeCard"
                  onClick={() => void connectWhitelabelHash(s.hash, s.label)}
                  disabled={busy}
                >
                  <i className="fa-solid fa-plug homeIcon" aria-hidden="true" />
                  <span className="homeCardTitle">Prox Voice #{i + 1}</span>
                  <span className="homeCardSub">{s.label}</span>
                </button>
              ))
            ) : whitelabel ? (
              <button className="homeCard" onClick={() => void connectWhitelabel()} disabled={busy}>
                <i className="fa-solid fa-plug homeIcon" aria-hidden="true" />
                <span className="homeCardTitle">Connect</span>
                <span className="homeCardSub">{whitelabel.serverLabel || whitelabel.appName || "Join server"}</span>
              </button>
            ) : (
              <button className="homeCard" onClick={() => setView("servers")}>
                <i className="fa-solid fa-server homeIcon" aria-hidden="true" />
                <span className="homeCardTitle">Server list</span>
                <span className="homeCardSub">Pick a server to join</span>
              </button>
            )}
          </div>
          <button className="homeSettings" onClick={() => setSettingsOpen(true)}>
            <i className="fa-solid fa-gear homeSettingsIcon" aria-hidden="true" />
            <span className="homeSettingsLabel">Settings</span>
            <span className="homeSettingsSub">Mic, keybinds, volume</span>
          </button>
          </div>
        </div>
      ) : null}

      {view === "servers" ? (
        <div className="view serversView">
          <div className="viewHead">
            <button className="btn btnSmall btn-ghost" onClick={() => setView("home")}>
              <i className="fa-solid fa-arrow-left" aria-hidden="true" /> Back
            </button>
            <div className="viewTitle">Server list</div>
            <button className="btn btnSmall btn-ghost" onClick={() => void refreshServers()} title="Refresh">
              <i className="fa-solid fa-rotate" aria-hidden="true" />
            </button>
          </div>
          <div className="serverTable">
            <div className="serverTableHead">
              <span className="colBanner" />
              <span className="colName">Server</span>
              <span className="colPlayers">In voice</span>
              <span className="colTier">Tier</span>
            </div>
            <div className="serverRows">
              {servers.length === 0 ? (
                <div className="participantsEmpty">
                  <i className="fa-solid fa-server" aria-hidden="true" />
                  <span>No registered servers online</span>
                </div>
              ) : (
                servers.map((s) => (
                  <button
                    key={s.hash}
                    className={`serverRow tier-${s.tier}`}
                    onClick={() => void openServer(s)}
                    disabled={busy}
                  >
                    <span
                      className={`colBanner ${s.bannerUrl ? "customBanner" : "bannerBlur"}`}
                      style={
                        s.bannerUrl
                          ? { backgroundImage: `url(${s.bannerUrl})`, backgroundSize: "cover", backgroundPosition: "center" }
                          : undefined
                      }
                      aria-hidden="true"
                    />
                    <span className="colName">
                      <span className="rowTierStrip" aria-hidden="true" />
                      <span className="serverName">{s.label}</span>
                    </span>
                    <span className="colPlayers">
                      <i className="fa-solid fa-microphone" aria-hidden="true" /> {s.playerCount ?? 0}
                    </span>
                    <span className="colTier">
                      <span className={`tierBadge tier-${s.tier}`}>{s.tier}</span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}

      {view === "mode" ? (
        <div className="view">
          <div className="viewHead">
            <button className="btn btnSmall btn-ghost" onClick={() => setView(whitelabel ? "home" : "servers")}>
              <i className="fa-solid fa-arrow-left" aria-hidden="true" /> Back
            </button>
            <div className="viewTitle">{selectedServer?.label ?? "Server"}</div>
            <span className="viewHeadSpacer" />
          </div>
          {selectedServer?.motd || selectedServer?.discordUrl ? (
            <div className="serverBrand">
              {selectedServer?.motd ? (
                <div className="motd" style={selectedServer.motdColor ? { color: selectedServer.motdColor } : undefined}>
                  {selectedServer.motd}
                </div>
              ) : null}
              {selectedServer?.discordUrl ? (
                <button
                  className="btn btn-ghost discordBtn"
                  onClick={() => selectedServer.discordUrl && bridge()?.openExternal?.(selectedServer.discordUrl)}
                >
                  <i className="fa-brands fa-discord" aria-hidden="true" /> Join Discord
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="modeCenter">
            <div className={selectedServer?.groupsEnabled !== false ? "homeGrid" : "homeGrid homeGridSingle"}>
              <button className="homeCard" onClick={() => selectedServer && void connectTo(selectedServer)} disabled={busy}>
                <i className="fa-solid fa-users homeIcon" aria-hidden="true" />
                <span className="homeCardTitle">Proximity Voice</span>
                <span className="homeCardSub">Talk to players near you</span>
              </button>
              {selectedServer?.groupsEnabled !== false ? (
                <button
                  className="homeCard"
                  onClick={() => {
                    setJoinName(null);
                    setView("groups");
                    void refreshGroups();
                  }}
                >
                  <i className="fa-solid fa-layer-group homeIcon" aria-hidden="true" />
                  <span className="homeCardTitle">Groups</span>
                  <span className="homeCardSub">Private channels</span>
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {view === "groups" ? (
        <div className="view">
          <div className="viewHead">
            <button className="btn btnSmall btn-ghost" onClick={() => setView("mode")}>
              <i className="fa-solid fa-arrow-left" aria-hidden="true" /> Back
            </button>
            <div className="viewTitle">Groups · {selectedServer?.label ?? ""}</div>
            <button className="btn btnSmall btn-ghost" onClick={() => void refreshGroups()} title="Refresh">
              <i className="fa-solid fa-rotate" aria-hidden="true" />
            </button>
          </div>
          <div className="card">
            <div className="cardTitle">Create group</div>
            <div className="row">
              <input
                className="input"
                placeholder="Group name"
                value={newGroupName}
                maxLength={40}
                onChange={(e) => setNewGroupName(e.target.value)}
              />
              <input
                className="input"
                placeholder="Password (optional)"
                type="password"
                value={newGroupPw}
                onChange={(e) => setNewGroupPw(e.target.value)}
              />
              <button
                className="btn btn-primary"
                disabled={busy || !newGroupName.trim()}
                onClick={() =>
                  selectedServer && void connectTo(selectedServer, newGroupName.trim(), newGroupPw || undefined)
                }
              >
                <i className="fa-solid fa-plus" aria-hidden="true" /> Create &amp; join
              </button>
            </div>
          </div>
          <div className="serverRows">
            {groupsList.length === 0 ? (
              <div className="participantsEmpty">
                <i className="fa-solid fa-layer-group" aria-hidden="true" />
                <span>No groups yet — create one</span>
              </div>
            ) : (
              groupsList.map((g) => (
                <div key={g.name} className="groupItem">
                  <button className="serverRow groupRow" onClick={() => onJoinGroup(g)} disabled={busy}>
                    <span className="colName">
                      <i className={`fa-solid ${g.hasPassword ? "fa-lock" : "fa-lock-open"}`} aria-hidden="true" />
                      <span className="serverName">{g.name}</span>
                    </span>
                    <span className="colPlayers">
                      <i className="fa-solid fa-microphone" aria-hidden="true" /> {g.memberCount}
                    </span>
                  </button>
                  {joinName === g.name && g.hasPassword ? (
                    <div className="row groupJoinPw">
                      <input
                        className="input"
                        type="password"
                        placeholder="Group password"
                        value={joinPw}
                        onChange={(e) => setJoinPw(e.target.value)}
                      />
                      <button
                        className="btn btn-primary"
                        disabled={busy}
                        onClick={() => selectedServer && void connectTo(selectedServer, g.name, joinPw)}
                      >
                        Join
                      </button>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}

      {view === "voice" ? (
        <div className="view voiceView">
          <div className="viewHead">
            <button className="btn btnSmall btn-danger" onClick={leave}>
              <i className="fa-solid fa-arrow-left" aria-hidden="true" /> Leave
            </button>
            <div className="viewTitle">
              {selectedServer?.label ?? "Connected"}
              {selectedChannel !== "prox" ? ` · ${selectedChannel}` : ""}
            </div>
            <span className="viewHeadSpacer" />
          </div>
          <div className="voiceBody">
            <div className="card voiceLeft">
              <div className="cardTitle">Controls</div>
              <button
                className={`btn ${effMuted ? "btn-danger" : "btn-ghost"}`}
                onClick={toggleMute}
                title={muted ? "Unmute" : "Mute"}
              >
                <i className={`fa-solid ${effMuted ? "fa-microphone-slash" : "fa-microphone"}`} aria-hidden="true" />
                {pushMuted && !muted ? "Muted (hold)" : muted ? "Muted" : "Mic on"}
              </button>
              <label className="field">
                <span className="fieldLabel">
                  Output <span className="volPct">{Math.round((settings?.outputVolume ?? 1) * 100)}%</span>
                </span>
                <input
                  className="range"
                  type="range"
                  min={0}
                  max={1.5}
                  step={0.01}
                  value={settings?.outputVolume ?? 1}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    void patchSettings({ outputVolume: v });
                    engineRef.current?.setMasterVolume(v);
                  }}
                />
              </label>
              <label className="field">
                <span className="fieldLabel">Microphone</span>
                <select
                  className="input"
                  value={settings?.micDeviceId ?? ""}
                  onChange={(e) => {
                    const id = e.target.value || null;
                    void patchSettings({ micDeviceId: id });
                    void engineRef.current?.setInputDevice(id);
                  }}
                >
                  <option value="">System default</option>
                  {devices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || d.deviceId.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="fieldLabel">Output device</span>
                <div className="row">
                  <select
                    className="input"
                    value={settings?.outputDeviceId ?? ""}
                    onChange={(e) => {
                      const id = e.target.value || null;
                      void patchSettings({ outputDeviceId: id });
                      void engineRef.current?.setOutputDevice(id);
                      void monitorRef.current.restart(monitorOpts({ outputDeviceId: id }));
                    }}
                  >
                    <option value="">System default</option>
                    {outputDevices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || d.deviceId.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn btnSmall btn-ghost"
                    onClick={() => void playTestTone(settings?.outputDeviceId ?? null)}
                    title="Play test sound on this device"
                  >
                    <i className="fa-solid fa-volume-high" aria-hidden="true" />
                  </button>
                </div>
              </label>
              <div className="legend">
                <span className={`dot ${status.voice === "open" ? "on" : "off"}`} aria-hidden="true" />
                Voice {status.voice === "open" ? "connected" : "disconnected"}
                <span className={`dot ${status.listen === "open" ? "on" : "off"}`} aria-hidden="true" />
                Position {status.listen === "open" ? "connected" : "disconnected"}
              </div>
            </div>
            <div className="card participantsCard voiceRight">
              <div className="cardTitle">
                Participants <span className="count">{selfIngame ? participants.length : 0}</span>
              </div>
              {selectedServer?.nameMode === "nickname" ? (
                <div style={{ padding: "0 12px 8px" }}>
                  <input
                    className="input"
                    style={{ width: "100%" }}
                    type="text"
                    maxLength={24}
                    placeholder="Your nickname"
                    value={myNick}
                    onChange={(e) => setMyNick(e.target.value)}
                    onBlur={() => engineRef.current?.setNickname(myNick.trim())}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") engineRef.current?.setNickname(myNick.trim());
                    }}
                  />
                </div>
              ) : null}
              {selectedServer?.hideNearby ? (
                <div className="banner bannerErr" style={{ margin: "0 12px 8px", borderRadius: 10 }}>
                  <i className="fa-solid fa-eye-slash" aria-hidden="true" />
                  <span>This server hides players who are nearby.</span>
                </div>
              ) : null}
              <div className="participants">
                {!selfIngame ? (
                  <div className="participantsEmpty">
                    <i className="fa-solid fa-gamepad" aria-hidden="true" />
                    <span>Join the game to see players</span>
                  </div>
                ) : participants.length === 0 ? (
                  <div className="participantsEmpty">
                    <i className="fa-solid fa-users-slash" aria-hidden="true" />
                    <span>No one connected</span>
                  </div>
                ) : (
                  participants.map((p) => (
                    <ParticipantRow
                      key={p.sid}
                      p={p}
                      onVolume={(sid, v) => engineRef.current?.setSpeakerVolume(sid, v)}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {settingsOpen ? (
        <Modal title="Settings" onClose={() => setSettingsOpen(false)}>
          <label className="field">
            <span className="fieldLabel">Microphone</span>
            <div className="row">
              <select
                className="input"
                value={settings?.micDeviceId ?? ""}
                onChange={(e) => void patchSettings({ micDeviceId: e.target.value || null })}
              >
                <option value="">System default</option>
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || d.deviceId.slice(0, 8)}
                  </option>
                ))}
              </select>
              <button className="btn btnSmall btn-ghost" onClick={() => void refreshDevices()} title="Reload devices">
                <i className="fa-solid fa-rotate" aria-hidden="true" />
              </button>
            </div>
          </label>

          <label className="field">
            <span className="fieldLabel">Output device</span>
            <div className="row">
              <select
                className="input"
                value={settings?.outputDeviceId ?? ""}
                onChange={(e) => {
                  const id = e.target.value || null;
                  void patchSettings({ outputDeviceId: id });
                  void engineRef.current?.setOutputDevice(id);
                  void monitorRef.current.restart(monitorOpts({ outputDeviceId: id }));
                }}
              >
                <option value="">System default</option>
                {outputDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || d.deviceId.slice(0, 8)}
                  </option>
                ))}
              </select>
              <button
                className="btn btnSmall btn-ghost"
                onClick={() => void playTestTone(settings?.outputDeviceId ?? null)}
                title="Play test sound on this device"
              >
                <i className="fa-solid fa-volume-high" aria-hidden="true" />
              </button>
              <button className="btn btnSmall btn-ghost" onClick={() => void refreshDevices()} title="Reload devices">
                <i className="fa-solid fa-rotate" aria-hidden="true" />
              </button>
            </div>
          </label>

          <label className="field">
            <span className="fieldLabel">
              Output volume <span className="volPct">{Math.round((settings?.outputVolume ?? 1) * 100)}%</span>
            </span>
            <input
              className="range"
              type="range"
              min={0}
              max={1.5}
              step={0.01}
              value={settings?.outputVolume ?? 1}
              onChange={(e) => {
                const v = Number(e.target.value);
                void patchSettings({ outputVolume: v });
                engineRef.current?.setMasterVolume(v);
              }}
            />
          </label>

          <label className="field">
            <span className="fieldLabel">Input mode</span>
            <select
              className="input"
              value={settings?.inputMode ?? "open"}
              onChange={(e) => {
                const mode = e.target.value as InputMode;
                void patchSettings({ inputMode: mode });
                engineRef.current?.setInputMode(mode);
              }}
            >
              <option value="open">Open mic</option>
              <option value="vad">Voice activity (VAD)</option>
              <option value="ptt">Push-to-talk</option>
            </select>
          </label>

          {settings?.inputMode === "vad" ? (
            <label className="field">
              <span className="fieldLabel">
                Voice gate <span className="volPct">{Math.round((settings?.vadThreshold ?? 0.012) * 1000)}</span>
              </span>
              <input
                className="range"
                type="range"
                min={0.001}
                max={0.08}
                step={0.001}
                value={settings?.vadThreshold ?? 0.012}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  void patchSettings({ vadThreshold: v });
                  engineRef.current?.setVadThreshold(v);
                }}
              />
            </label>
          ) : null}

          <label className="field">
            <span className="fieldLabel">
              Input volume <span className="volPct">{Math.round((settings?.inputVolume ?? 1) * 100)}%</span>
            </span>
            <input
              className="range"
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={settings?.inputVolume ?? 1}
              onChange={(e) => {
                const v = Number(e.target.value);
                void patchSettings({ inputVolume: v });
                engineRef.current?.setInputVolume(v);
                monitorRef.current.setGain(v);
              }}
            />
          </label>

          <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: "10px" }}>
            <input
              type="checkbox"
              checked={settings?.noiseSuppression ?? true}
              onChange={(e) => {
                const v = e.target.checked;
                void patchSettings({ noiseSuppression: v });
                engineRef.current?.setAudioConstraints(v, settings?.autoGainControl ?? false);
                void monitorRef.current.restart(monitorOpts({ noiseSuppression: v }));
              }}
            />
            <span className="fieldLabel" style={{ margin: 0 }}>
              Noise suppression
            </span>
          </label>

          <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: "10px" }}>
            <input
              type="checkbox"
              checked={settings?.autoGainControl ?? true}
              onChange={(e) => {
                const v = e.target.checked;
                void patchSettings({ autoGainControl: v });
                engineRef.current?.setAudioConstraints(settings?.noiseSuppression ?? false, v);
                void monitorRef.current.restart(monitorOpts({ autoGainControl: v }));
              }}
            />
            <span className="fieldLabel" style={{ margin: 0 }}>
              Auto gain control
            </span>
          </label>

          <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: "10px" }}>
            <input
              type="checkbox"
              checked={settings?.selfMonitor ?? false}
              onChange={(e) => {
                const v = e.target.checked;
                void patchSettings({ selfMonitor: v });
                if (v) void monitorRef.current.start(monitorOpts());
                else void monitorRef.current.stop();
              }}
            />
            <span className="fieldLabel" style={{ margin: 0 }}>
              Hear myself (mic test)
            </span>
          </label>

          {settings?.inputMode === "ptt" ? (
            <label className="field">
              <span className="fieldLabel">Push-to-talk key (hold)</span>
              <KeyCapture
                value={settings?.pttKey ?? ""}
                onChange={(code) => void patchSettings({ pttKey: code })}
                capturingRef={capturingRef}
              />
            </label>
          ) : null}

          <label className="field">
            <span className="fieldLabel">Push-to-mute key (hold)</span>
            <KeyCapture
              value={settings?.pushToMuteKey ?? ""}
              onChange={(code) => void patchSettings({ pushToMuteKey: code })}
              capturingRef={capturingRef}
            />
          </label>

          <label className="field">
            <span className="fieldLabel">Toggle-mute key</span>
            <KeyCapture
              value={settings?.toggleMuteKey ?? ""}
              onChange={(code) => void patchSettings({ toggleMuteKey: code })}
              capturingRef={capturingRef}
            />
          </label>

          <div className="hint">
            {globalKeys
              ? "Keybinds work globally, also while you are in the game."
              : "Global key hook unavailable — keybinds only work while this window is focused."}
          </div>
        </Modal>
      ) : null}

      {devOpen && steamId === OWNER_SID ? (
        <DevModal
          settings={settings}
          patchSettings={patchSettings}
          steamId={steamId}
          setSteamId={setSteamId}
          setError={setError}
          onClose={() => setDevOpen(false)}
        />
      ) : null}

      {changelogOpen ? (
        <Modal title="What's new" onClose={closeChangelog}>
          {CHANGELOG.map((entry) => (
            <div key={entry.version} className="field">
              <span className="fieldLabel">v{entry.version}</span>
              <ul className="changelogList">
                {entry.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
          <button className="btn" onClick={closeChangelog}>
            Got it
          </button>
        </Modal>
      ) : null}

      {bugOpen ? (
        <BugReportModal
          centralUrl={settings?.centralUrl ?? ""}
          steamId={steamId}
          onClose={() => setBugOpen(false)}
        />
      ) : null}
    </div>
  );
};

const Modal = ({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) => (
  <div className="modalBackdrop" onClick={onClose}>
    <div className="modal" onClick={(e) => e.stopPropagation()}>
      <div className="modalHeader">
        <span>{title}</span>
        <button className="iconBtn" onClick={onClose} title="Close">
          <i className="fa-solid fa-xmark" aria-hidden="true" />
        </button>
      </div>
      <div className="modalBody">{children}</div>
    </div>
  </div>
);

const BugReportModal = ({
  centralUrl,
  steamId,
  onClose,
}: {
  centralUrl: string;
  steamId: string | null;
  onClose: () => void;
}) => {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const send = async () => {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const base = centralUrl.replace(/^ws/, "http").replace(/\/+$/, "");
      const res = await fetch(`${base}/bug-report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, version: __APP_VERSION__, name: steamId ?? "" }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setSent(true);
      window.setTimeout(onClose, 1500);
    } catch {
      setErr("Could not send the report. Try again in a minute.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Report a bug" onClose={onClose}>
      {sent ? (
        <div className="hint">Thanks! Your report was sent to the team.</div>
      ) : (
        <>
          <label className="field">
            <span className="fieldLabel">What happened?</span>
            <textarea
              className="input"
              rows={5}
              maxLength={1500}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="What broke, what did you expect, and what were you doing when it happened?"
            />
          </label>
          {err ? <div className="hint">{err}</div> : null}
          <button className="btn" onClick={() => void send()} disabled={busy || !text.trim()}>
            {busy ? "Sending…" : "Send report"}
          </button>
        </>
      )}
    </Modal>
  );
};

const DevModal = ({
  settings,
  patchSettings,
  steamId,
  setSteamId,
  setError,
  onClose,
}: {
  settings: OverlaySettings | null;
  patchSettings: (patch: Partial<OverlaySettings>) => Promise<OverlaySettings | undefined>;
  steamId: string | null;
  setSteamId: (id: string | null) => void;
  setError: (e: string | null) => void;
  onClose: () => void;
}) => {
  const [manualSid, setManualSid] = useState(steamId ?? "");

  const setSid = async () => {
    const sid = manualSid.trim();
    if (!/^\d{17}$/.test(sid)) {
      setError("SteamID64 must be 17 digits.");
      return;
    }
    const saved = await patchSettings({ steamId: sid });
    setSteamId(saved?.steamId ?? null);
    setError(null);
  };

  return (
    <Modal title="Developer settings" onClose={onClose}>
      <div className="row">
        <button
          className="btn btnSmall btn-ghost"
          onClick={() => void patchSettings({ apiBaseUrl: "http://127.0.0.1:8787", centralUrl: "ws://127.0.0.1:13338" })}
        >
          <i className="fa-solid fa-laptop-code" aria-hidden="true" /> Use localhost
        </button>
        <button
          className="btn btnSmall btn-ghost"
          onClick={() =>
            void patchSettings({ apiBaseUrl: "https://voip.islepilot.eu", centralUrl: "wss://voip.islepilot.eu" })
          }
        >
          <i className="fa-solid fa-globe" aria-hidden="true" /> Use production
        </button>
      </div>

      <label className="field">
        <span className="fieldLabel">API URL</span>
        <input
          className="input mono"
          value={settings?.apiBaseUrl ?? ""}
          onChange={(e) => void patchSettings({ apiBaseUrl: e.target.value })}
          spellCheck={false}
        />
      </label>

      <label className="field">
        <span className="fieldLabel">Central URL (WebSocket)</span>
        <input
          className="input mono"
          value={settings?.centralUrl ?? ""}
          onChange={(e) => void patchSettings({ centralUrl: e.target.value })}
          spellCheck={false}
        />
      </label>

      <label className="field">
        <span className="fieldLabel">Manual SteamID64 (local dev only)</span>
        <div className="row">
          <input
            className="input mono"
            value={manualSid}
            onChange={(e) => setManualSid(e.target.value)}
            placeholder="7656119..."
            spellCheck={false}
          />
          <button className="btn btnSmall btn-ghost" onClick={() => void setSid()}>
            Set
          </button>
        </div>
      </label>
      <div className="hint">Manual SteamID only works against a local API with DEV_ALLOW_MANUAL_STEAM=1.</div>
    </Modal>
  );
};

const KeyCapture = ({
  value,
  onChange,
  capturingRef,
}: {
  value: string;
  onChange: (code: string) => void;
  capturingRef: React.MutableRefObject<boolean>;
}) => {
  const [listening, setListening] = useState(false);
  useEffect(() => {
    capturingRef.current = listening;
    if (!listening) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setListening(false);
        return;
      }
      onChange(e.code);
      setListening(false);
    };
    const mouseHandler = (e: MouseEvent) => {
      const c = mouseCode(e.button);
      if (!c) return;
      e.preventDefault();
      e.stopPropagation();
      onChange(c);
      setListening(false);
    };
    window.addEventListener("keydown", handler, true);
    window.addEventListener("mousedown", mouseHandler, true);
    return () => {
      window.removeEventListener("keydown", handler, true);
      window.removeEventListener("mousedown", mouseHandler, true);
      capturingRef.current = false;
    };
  }, [listening, onChange, capturingRef]);

  return (
    <div className="row">
      <button
        type="button"
        className={`input keybindBtn ${listening ? "listening" : ""}`}
        onClick={() => setListening((v) => !v)}
      >
        {listening ? "Press a key… (Esc to cancel)" : value || "Unbound"}
      </button>
      {value && !listening ? (
        <button className="btn btnSmall btn-ghost" onClick={() => onChange("")} title="Clear">
          <i className="fa-solid fa-xmark" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
};

const StatusChip = ({ label, state }: { label: string; state: ConnState }) => {
  const open = state === "open";
  const icon = open ? "fa-plug-circle-check" : state === "connecting" ? "fa-spinner fa-spin" : "fa-plug-circle-xmark";
  return (
    <div className={`statusChip ${open ? "chipOn" : "chipOff"}`} title={`${label}: ${state}`}>
      <i className={`fa-solid ${icon}`} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
};

const ParticipantRow = ({
  p,
  onVolume,
}: {
  p: Participant;
  onVolume: (sid: string, v: number) => void;
}) => {
  // Colorblind-safe: talking state via icon + ring + pulse + text, not color alone.
  const icon = !p.inRange
    ? "fa-signal"
    : p.isSelf
      ? p.speaking
        ? "fa-microphone"
        : "fa-microphone-slash"
      : p.speaking
        ? "fa-volume-high"
        : "fa-volume-off";
  return (
    <div className={`participant ${p.speaking ? "speaking" : ""} ${p.inRange ? "" : "outRange"}`}>
      <div className="pIcon">
        <i className={`fa-solid ${icon}`} aria-hidden="true" />
      </div>
      <div className="pMain">
        <div className="pName mono">
          {p.name ?? p.sid}
          {p.isSelf ? <span className="youTag">YOU</span> : null}
        </div>
        {p.name ? <div className="mono" style={{ fontSize: "0.72em", opacity: 0.55 }}>{p.sid}</div> : null}
        <div className="pMeta">
          <span className="pState">
            {!p.inRange
              ? p.distance === null
                ? "connected, not in game"
                : "out of range"
              : p.speaking
                ? "talking"
                : "silent"}
          </span>
        </div>
        {!p.isSelf ? (
          <div className="pVolRow">
            <i className="fa-solid fa-volume-low" aria-hidden="true" />
            <input
              className="range pVol"
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={p.volume}
              onChange={(e) => onVolume(p.sid, Number(e.target.value))}
              title="Player volume"
            />
          </div>
        ) : null}
      </div>
      {p.speaking ? <div className="pPulse" aria-hidden="true" /> : null}
    </div>
  );
};
