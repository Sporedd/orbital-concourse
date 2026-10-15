/**
 * Shared biped run cycle for the trooper rigs (grunt, spitter, bomber, brute; arms only for the
 * summoner). Hip + knee, shoulder + elbow, a forward lean, shoulder counter-twist and a bob that
 * lowers the hips at mid-stance. Knee / elbow pivots live in rig.parts (knee0/knee1,
 * elbow0/elbow1); rigs without them (other kinds) just get the hip/shoulder swing.
 */
import type { Rig } from './models';

export interface RunOpts {
  /** hip swing amplitude (rad) at full speed */
  stride?: number;
  /** shoulder swing amplitude (rad) at full speed */
  arms?: number;
  /** extra elbow bend at full speed (rad) */
  elbow?: number;
  /** extra knee lift in the swing phase (rad) */
  knee?: number;
  /** vertical bob (m, rig units) at full speed */
  bob?: number;
  /** shoulder counter-twist (rad) */
  twist?: number;
}

/**
 * Pose legs/knees/arms/elbows for walk phase `phase` at blend `amp` (0 idle .. 1 full run).
 * Returns the bob (rig units) the caller adds to body.position.y; the legs get it already.
 * Leaves body lean/height to the caller.
 */
export function poseRun(rig: Rig, phase: number, amp: number, o: RunOpts = {}): number {
  const A = (o.stride ?? 0.8) * amp;
  const armA = (o.arms ?? 0.85) * amp;
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  // hips are lowest at mid-stance (feet passing under the body), twice per cycle
  const bob = -Math.abs(c) * (o.bob ?? 0.05) * amp;
  for (let i = 0; i < rig.legs.length && i < 2; i++) {
    const sg = i === 0 ? 1 : -1;
    const psi = phase + (i === 0 ? 0 : Math.PI);
    const sp = s * sg;
    const leg = rig.legs[i];
    leg.rotation.x = -sp * A; // negative = foot forward (+Z)
    const baseY = leg.userData.baseY as number | undefined;
    if (baseY !== undefined) leg.position.y = baseY + bob;
    const knee = rig.parts[`knee${i}`];
    // the knee folds while the leg swings forward (peak just behind vertical), nearly straight in stance
    if (knee) knee.rotation.x = 0.12 + amp * (0.1 + (o.knee ?? 1.3) * Math.max(0, Math.cos(psi + 0.45)));
  }
  for (let i = 0; i < rig.arms.length && i < 2; i++) {
    const sg = i === 0 ? 1 : -1;
    const sp = s * sg;
    const arm = rig.arms[i];
    // arm opposite to the same-side leg: positive = hand back
    arm.rotation.x = sp * armA;
    const el = rig.parts[`elbow${i}`];
    if (el) el.rotation.x = -(0.35 + (o.elbow ?? 1.0) * amp) - Math.max(0, -sp) * 0.35 * amp;
  }
  rig.body.rotation.y = s * (o.twist ?? 0.12) * amp;
  if (rig.head) rig.head.rotation.y = -rig.body.rotation.y * 0.8;
  return bob;
}

/** Reset knees/elbows to their rest bend (attack poses that drive shoulders directly). */
export function setElbows(rig: Rig, l: number, r: number): void {
  const e0 = rig.parts.elbow0;
  const e1 = rig.parts.elbow1;
  if (e0) e0.rotation.x = l;
  if (e1) e1.rotation.x = r;
}
