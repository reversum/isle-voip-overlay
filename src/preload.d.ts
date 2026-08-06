import type { OverlaySettings } from "./types";
import type { ServerInfo, VoiceTicketResult } from "./voice/types";

declare global {
  interface Window {
    isleVoip?: {
      getSettings: () => Promise<OverlaySettings>;
      setSettings: (next: Partial<OverlaySettings>) => Promise<OverlaySettings>;
      steamLogin: () => Promise<{ steamId: string } | null>;
      getAuth: () => Promise<{ steamId: string | null }>;
      logout: () => Promise<void>;
      onAuthChanged: (cb: (payload: { steamId: string | null }) => void) => void;
      getVoiceTicket: () => Promise<VoiceTicketResult>;
      listServers: () => Promise<{ servers?: ServerInfo[]; error?: string }>;
      listLinkedServers: (
        hash: string,
      ) => Promise<{ linked?: boolean; servers?: Array<{ hash: string; label: string; tier: string }>; error?: string }>;
      listGroups: (
        hash: string,
      ) => Promise<{ groups?: { name: string; memberCount: number; hasPassword: boolean }[]; error?: string }>;
      globalKeysActive: () => Promise<boolean>;
      onGlobalKey: (cb: (payload: { type: "down" | "up"; code: string }) => void) => () => void;
      minimizeWindow: () => Promise<void>;
      maximizeToggle: () => Promise<void>;
      closeWindow: () => Promise<void>;
      openExternal: (url: string) => Promise<void>;
      getWhitelabel: () => Promise<{
        serverHash: string;
        serverLabel?: string;
        tier?: string;
        appName?: string;
      } | null>;
      updaterRestart: () => Promise<boolean>;
      updaterCheck: () => Promise<boolean>;
      updaterGetState: () => Promise<UpdaterState>;
      onUpdaterEvent: (cb: (payload: UpdaterState) => void) => () => void;
    };
  }

  type UpdaterState = {
    state: "idle" | "none" | "available" | "downloading" | "downloaded" | "error";
    version?: string;
    percent?: number;
    message?: string;
  };
}

export {};
