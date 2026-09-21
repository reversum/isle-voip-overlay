export type Vec3 = [number, number, number];

export type SnapshotPlayer = {
  sid: string;
  name?: string;
  linked?: string;
  pos: Vec3;
  rot: Vec3;
  radius?: number;
  radiusM?: string | number;
};

export type Snapshot = {
  players: SnapshotPlayer[];
  channel?: string;
  spatialVoice?: boolean;
  version?: number;
};

export type VoiceTicketOk = { ticket: string; steamId64: string; expiresAt: string };
export type VoiceTicketResult = VoiceTicketOk | { error: string; status?: number };

export type ServerInfo = {
  hash: string;
  label: string;
  tier: string;
  serverIp: string | null;
  online: boolean;
  playerCount?: number;
  motd?: string | null;
  motdColor?: string | null;
  discordUrl?: string | null;
  bannerUrl?: string | null;
  groupsEnabled?: boolean;
  maxGroups?: number | null;
  maxGroupMembers?: number | null;
  nameMode?: "steam" | "nickname" | "none";
  hideNearby?: boolean;
};

export type ConnState = "idle" | "connecting" | "open" | "closed";

export type LicenseInfo = {
  tier?: string | null;
  features?: { paid?: boolean; premium?: boolean; ultra?: boolean };
};

export type Participant = {
  sid: string;
  name?: string;
  isSelf: boolean;
  speaking: boolean;
  hasAudio: boolean;
  inRange: boolean;
  distance: number | null;
  volume: number;
};
