import type { Vec3 } from "./types";

export const WORLD_TO_AUDIO = 1;
export const METERS_TO_WORLD = 100;

export function unrealToAudio(pos: Vec3, scale = WORLD_TO_AUDIO): Vec3 {
  return [pos[1] * scale, pos[2] * scale, -pos[0] * scale];
}

export function yawToForward(yawDeg: number): Vec3 {
  const r = (yawDeg * Math.PI) / 180;
  return [Math.sin(r), 0, -Math.cos(r)];
}

export function distanceWorld(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function setListener(ctx: AudioContext, pos: Vec3, yawDeg: number): void {
  const [x, y, z] = unrealToAudio(pos);
  const [fx, fy, fz] = yawToForward(yawDeg);
  const l = ctx.listener;
  if ("positionX" in l && l.positionX) {
    l.positionX.value = x;
    l.positionY.value = y;
    l.positionZ.value = z;
    l.forwardX.value = fx;
    l.forwardY.value = fy;
    l.forwardZ.value = fz;
    l.upX.value = 0;
    l.upY.value = 1;
    l.upZ.value = 0;
  } else {
    (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
    (
      l as unknown as {
        setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
      }
    ).setOrientation(fx, fy, fz, 0, 1, 0);
  }
}

export function positionPanner(panner: PannerNode, pos: Vec3): void {
  const [x, y, z] = unrealToAudio(pos);
  if ("positionX" in panner && panner.positionX) {
    panner.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;
  } else {
    (panner as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
  }
}
