import type { ConnState, LicenseInfo, Snapshot } from "./types";

const STALL_MS = 25_000;

export class SnapshotClient {
  private ws: WebSocket | null = null;
  private centralUrl = "";
  private hash = "";
  private ticket = "";
  private refreshTicket: (() => Promise<string>) | null = null;
  private intentional = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private lastMsgAt = 0;
  onSnapshot: ((snapshot: Snapshot) => void) | null = null;
  onLicense: ((license: LicenseInfo) => void) | null = null;
  onState: ((state: ConnState) => void) | null = null;

  connect(
    centralUrl: string,
    hash: string,
    ticket = "",
    refreshTicket?: () => Promise<string>,
  ): void {
    this.centralUrl = centralUrl;
    this.hash = hash;
    this.ticket = ticket;
    this.refreshTicket = refreshTicket ?? null;
    this.intentional = false;
    this.attempts = 0;
    void this.open();
  }

  private async open(): Promise<void> {
    this.clearTimer();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
      }
      this.ws = null;
    }
    if (this.refreshTicket) {
      try {
        const fresh = await this.refreshTicket();
        if (fresh) this.ticket = fresh;
      } catch {
      }
      if (this.intentional) return;
    }
    const base = this.centralUrl.replace(/\/+$/, "");
    const t = this.ticket ? `&t=${encodeURIComponent(this.ticket)}` : "";
    const ws = new WebSocket(`${base}/listen/${this.hash}?v=${__APP_VERSION__}${t}`);
    this.ws = ws;
    this.onState?.("connecting");

    ws.onopen = () => {
      this.attempts = 0;
      this.lastMsgAt = Date.now();
      this.startStallWatch(ws);
      this.onState?.("open");
    };
    ws.onclose = () => {
      if (this.ws === ws) {
        this.stopStallWatch();
        this.ws = null;
        this.onState?.("closed");
        if (!this.intentional) this.scheduleReconnect();
      }
    };
    ws.onerror = () => {
    };
    ws.onmessage = (ev) => {
      this.lastMsgAt = Date.now();
      if (typeof ev.data !== "string") return;
      let msg: unknown;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg && typeof msg === "object" && (msg as { type?: string }).type === "license_status") {
        this.onLicense?.(msg as LicenseInfo);
        return;
      }
      if (msg && typeof msg === "object" && Array.isArray((msg as Snapshot).players)) {
        this.onSnapshot?.(msg as Snapshot);
      }
    };
  }

  private scheduleReconnect(): void {
    this.clearTimer();
    const delay = Math.min(15000, 1000 * 2 ** Math.min(this.attempts, 4));
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.intentional) void this.open();
    }, delay);
  }

  private startStallWatch(ws: WebSocket): void {
    this.stopStallWatch();
    this.stallTimer = setInterval(() => {
      if (this.ws !== ws) {
        this.stopStallWatch();
        return;
      }
      if (Date.now() - this.lastMsgAt > STALL_MS) {
        try {
          ws.close();
        } catch {
        }
      }
    }, 10_000);
  }

  private stopStallWatch(): void {
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private clearTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  close(): void {
    this.intentional = true;
    this.clearTimer();
    this.stopStallWatch();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
      }
      this.ws = null;
    }
  }
}
