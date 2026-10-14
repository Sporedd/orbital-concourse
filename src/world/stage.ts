/**
 * The live colosseum (docs/ART_DIRECTION.md §5, §7): floodlight towers (lattice pylon + lamp
 * head) with their SpotLight, haze shaft and floor pool; airlock gate doors and status lamps
 * (THREAT telegraph + pooled red PointLights); the boss gate entrance sequence; spotlight
 * swings for the boss and legendary drops; tower flicker in Scrap. League switches rebuild
 * only light counts and colours.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeGlow, makeSurface } from '@/rendering/materials';
import { createShaft, type Shaft } from '@/rendering/shafts';
import { LUM, PALETTE, glowLum, type LeagueStyle } from '@/rendering/style';
import { trs } from './batcher';
import { createFloorPool, type FloorPool } from './pools';
import { DIM, ROW_RISE, TIERS, type GateDef } from './props';
import { createPuffs, type Puffs } from './puffs';
import { createFloorStrobe } from './strobe';

/** Tower order: the first N are used by a league with N towers. */
export const TOWER_ANGLES = [225, 315, 135, 45, 180, 0, 270, 90];

const SPOT_INTENSITY = 2600;
const SPOT_ANGLE = 0.38;
const SHAFT_RADIUS = 7;
/** Additive floor-pool luminance at the centre (on top of the key-lit floor). */
const POOL_I = 0.18;
/** Pool radius across the beam: the bright core of the cone, tighter than the haze shaft. */
const POOL_RADIUS = 4.4;

interface Tower {
  angle: number;
  group: THREE.Group;
  lampMat: THREE.MeshBasicMaterial;
  lampPos: THREE.Vector3;
  home: THREE.Vector3;
  aim: THREE.Vector3;
  from: THREE.Vector3;
  to: THREE.Vector3;
  swingT: number;
  swingDur: number;
  holdT: number;
  spot: THREE.SpotLight | null;
  shaft: Shaft;
  pool: FloorPool;
  dropout: number;
  nextFlicker: number;
}

interface Gate {
  def: GateDef;
  doors: THREE.Mesh[];
  doorShift: number;
  open: number;
  /** Door travel time for the current cycle (s). */
  openTime: number;
  /** Seconds since the last door jolt (open kick / slam shut). */
  jolt: number;
  alertT: number;
  holdOpen: number;
  /** Gate mouth (floor level, arena side) and inward direction, for puffs. */
  mouth: THREE.Vector3;
  inward: THREE.Vector3;
  lampMat: THREE.MeshBasicMaterial;
  lampPos: THREE.Vector3;
  chase: THREE.MeshBasicMaterial[];
  /** Red backlight inside the airlock (hidden by the closed doors). */
  back: { value: number };
}

export interface Stage {
  readonly group: THREE.Group;
  /** Shared haze puff pool (gates, vents). */
  readonly puffs: Puffs;
  setLeague(ls: LeagueStyle): void;
  /** A mob is coming through the gate nearest to `p`. */
  telegraph(p: THREE.Vector3): void;
  bossEntrance(): void;
  /** Swing `count` spots onto a point for `seconds`. */
  spotlight(p: THREE.Vector3, count: number, seconds: number): void;
  update(dt: number): void;
}

const tmpV = new THREE.Vector3();

function buildTowerGeometry(): { lattice: THREE.BufferGeometry; discs: THREE.BufferGeometry; lampLocal: THREE.Vector3 } {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, m: THREE.Matrix4) => {
    const c = (g.index ? g.toNonIndexed() : g.clone()).applyMatrix4(m);
    for (const n of Object.keys(c.attributes)) if (n !== 'position' && n !== 'normal') c.deleteAttribute(n);
    parts.push(c);
  };
  const box = new THREE.BoxGeometry(1, 1, 1);
  const baseY = TIERS[2].faceTop + ROW_RISE * 3;
  const topY = DIM.roofY - 1.3;
  const h = topY - baseY;
  const s = 0.9; // half size of the pylon footprint
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(box, trs(sx * s, baseY + h / 2, sz * s, 0.22, h, 0.22));
  // X braces on all four faces every 2 m
  const n = Math.max(2, Math.round(h / 2));
  const seg = h / n;
  const diag = Math.hypot(2 * s, seg);
  const ang = Math.atan2(seg, 2 * s);
  for (let i = 0; i < n; i++) {
    const y = baseY + seg * (i + 0.5);
    for (const sgn of [-1, 1]) {
      add(box, trs(0, y, s, diag, 0.08, 0.08, 0, 0, sgn * ang));
      add(box, trs(0, y, -s, diag, 0.08, 0.08, 0, 0, sgn * ang));
      add(box, trs(s, y, 0, 0.08, 0.08, diag, sgn * ang, 0, 0));
      add(box, trs(-s, y, 0, 0.08, 0.08, diag, sgn * ang, 0, 0));
    }
    add(box, trs(0, baseY + seg * (i + 1), 0, 2 * s, 0.1, 2 * s));
  }
  // lamp head: 6 × 3 panel facing local +z (the arena), tilted down
  const headY = topY - 1.9;
  const tilt = 0.5;
  const H = new THREE.Matrix4().multiplyMatrices(trs(0, headY, 1.4), trs(0, 0, 0, 1, 1, 1, tilt, 0, 0));
  add(box, new THREE.Matrix4().multiplyMatrices(H, trs(0, 0, 0, 6.2, 3.2, 0.5)));
  add(box, trs(0, headY, 0.9, 0.3, 0.3, 1.2));
  const lattice = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  // discs: 3 × 6 grid
  const dparts: THREE.BufferGeometry[] = [];
  const disc = new THREE.CircleGeometry(0.4, 16);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 6; c++) {
      const m = new THREE.Matrix4().multiplyMatrices(H, trs(-2.5 + c * 1.0, -1.0 + r * 1.0, 0.26));
      const g = disc.clone().applyMatrix4(m);
      g.deleteAttribute('uv');
      dparts.push(g);
    }
  }
  const discs = mergeGeometries(dparts, false)!;
  for (const p of dparts) p.dispose();
  const lampLocal = new THREE.Vector3(0, 0, 0.4).applyMatrix4(H);
  return { lattice, discs, lampLocal };
}

export function createStage(scene: THREE.Scene, gates: GateDef[], rand: () => number): Stage {
  const group = new THREE.Group();
  group.name = 'world-stage';
  const latticeMat = makeSurface({ color: PALETTE.STEEL_DARK, surface: 'steel', grime: 0 });
  const doorMat = makeSurface({ color: PALETTE.STEEL, surface: 'steel', sheen: 0.12 });
  const doorTrim = makeSurface({ color: PALETTE.STEEL_DARK, surface: 'steel' });
  const tg = buildTowerGeometry();

  // ---- towers ---------------------------------------------------------------------------
  const towers: Tower[] = TOWER_ANGLES.map((angle, i) => {
    const g = new THREE.Group();
    const a = THREE.MathUtils.degToRad(angle);
    g.position.set(Math.cos(a) * DIM.towerR, 0, Math.sin(a) * DIM.towerR);
    g.rotation.y = -Math.PI / 2 - a; // local +z toward the centre
    const lat = new THREE.Mesh(tg.lattice, latticeMat);
    lat.castShadow = false;
    g.add(lat);
    const lampMat = makeGlow(PALETTE.FLOODLIGHT, glowLum(PALETTE.FLOODLIGHT, LUM.lamp));
    lampMat.fog = false;
    const discs = new THREE.Mesh(tg.discs, lampMat);
    g.add(discs);
    g.updateMatrixWorld(true);
    const lampPos = tg.lampLocal.clone().applyMatrix4(g.matrixWorld);
    // diagonal towers light the four quarters, cardinal ones (Star/Void) the inner ring:
    // pools stay apart in every league
    const diag = angle % 90 !== 0;
    const ta = a + THREE.MathUtils.degToRad(diag ? (i % 2 ? -10 : 10) : 0);
    const hr = diag ? 12.5 : 7;
    const home = new THREE.Vector3(Math.cos(ta) * hr, 0, Math.sin(ta) * hr);
    const shaft = createShaft(lampPos, home, SHAFT_RADIUS, PALETTE.FLOODLIGHT, 0.16, rand);
    const pool = createFloorPool(lampPos, home, POOL_RADIUS, PALETTE.FLOODLIGHT, POOL_I);
    group.add(g, shaft.group, pool.mesh);
    return {
      angle, group: g, lampMat, lampPos, home, aim: home.clone(), from: home.clone(), to: home.clone(),
      swingT: 0, swingDur: 0, holdT: 0, spot: null, shaft, pool, dropout: 0, nextFlicker: 8 + rand() * 12,
    };
  });

  // ---- gates (doors, lamps) ----------------------------------------------------------------
  const gateLights: THREE.PointLight[] = [];
  for (let i = 0; i < 4; i++) {
    const l = new THREE.PointLight(PALETTE.THREAT, 0, 14, 2);
    l.castShadow = false;
    group.add(l);
    gateLights.push(l);
  }
  const lightOwner: (Gate | null)[] = [null, null, null, null];
  const idleLamp = new THREE.Color(PALETTE.LAMP_IDLE).multiplyScalar(0.6);
  const threatLamp = new THREE.Color(PALETTE.THREAT).multiplyScalar(glowLum(PALETTE.THREAT, 2.0, 12));
  const doorGeo = new THREE.BoxGeometry(1, 1, 1);
  const gateObjs: Gate[] = gates.map((def) => {
    const boss = def.kind === 'boss';
    const a = THREE.MathUtils.degToRad(def.angle);
    const F = new THREE.Group();
    const r = boss ? 32.85 : 32.55;
    F.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    F.rotation.y = -Math.PI / 2 - a;
    const dw = boss ? 6.1 : 3.05;
    const dh = boss ? 9.1 : 5.0;
    const doors: THREE.Mesh[] = [];
    for (const sx of [-1, 1]) {
      const d = new THREE.Mesh(doorGeo, doorMat);
      d.scale.set(dw, dh, 0.3);
      d.position.set(sx * dw / 2, dh / 2, 0);
      d.userData.sx = sx;
      d.userData.base = sx * dw / 2;
      d.castShadow = true;
      d.receiveShadow = true;
      F.add(d);
      doors.push(d);
      // vertical ribs on each door
      for (let k = 0; k < (boss ? 4 : 2); k++) {
        const rib = new THREE.Mesh(doorGeo, doorTrim);
        rib.scale.set(0.12 / dw, 0.92, 1.4);
        rib.position.set((-0.3 + (0.6 * k) / Math.max(1, (boss ? 3 : 1))) , 0, 0.5);
        d.add(rib);
      }
    }
    // airlock backlight: a soft THREAT glow at the back of the tunnel, seen once the doors part
    const back = { value: 0 };
    const backMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(PALETTE.THREAT).multiplyScalar(glowLum(PALETTE.THREAT, 1.3, 12)) }, uI: back },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 uColor; uniform float uI; varying vec2 vUv; void main(){ float e = smoothstep(0.0, 0.18, vUv.x) * (1.0 - smoothstep(0.82, 1.0, vUv.x)); float v = mix(1.0, 0.35, vUv.y) * (1.0 - smoothstep(0.85, 1.0, vUv.y)); float a = uI * e * v; if (a <= 0.001) discard; gl_FragColor = vec4(uColor * a, 1.0); }',
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    backMat.userData.noInk = true;
    const backPlane = new THREE.Mesh(new THREE.PlaneGeometry(boss ? 12 : 5.9, boss ? 9 : 4.9), backMat);
    // just in front of the tunnel end wall (mob r 33.8, boss r 34.8)
    backPlane.position.set(0, boss ? 4.5 : 2.45, boss ? -1.7 : -1.1);
    F.add(backPlane);
    group.add(F);
    const lampMat = makeGlow(0xffffff, 1);
    lampMat.color.copy(idleLamp);
    const lamp = new THREE.Mesh(doorGeo, lampMat);
    const lampY = boss ? 11.95 : 6.75;
    const lr = 30.25;
    lamp.position.set(Math.cos(a) * lr, lampY, Math.sin(a) * lr);
    lamp.rotation.y = F.rotation.y;
    lamp.scale.set(boss ? 1.2 : 0.7, 0.22, 0.2);
    group.add(lamp);
    // boss: chase lamps along the lintel
    const chase: THREE.MeshBasicMaterial[] = [];
    if (boss) {
      for (let k = 0; k < 8; k++) {
        const m = makeGlow(0xffffff, 1);
        m.color.copy(idleLamp);
        const c = new THREE.Mesh(doorGeo, m);
        const t = -5.25 + k * 1.5;
        const p = new THREE.Vector3(t, 8.85, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), F.rotation.y);
        c.position.set(Math.cos(a) * 30.05 + p.x, 8.85, Math.sin(a) * 30.05 + p.z);
        c.rotation.y = F.rotation.y;
        c.scale.set(0.5, 0.18, 0.1);
        group.add(c);
        chase.push(m);
      }
    }
    const inward = new THREE.Vector3(-Math.cos(a), 0, -Math.sin(a));
    return {
      def, doors, doorShift: boss ? 5.9 : 2.9, open: 0, openTime: 0.6, jolt: 99, alertT: 0, holdOpen: 0, lampMat,
      mouth: new THREE.Vector3(Math.cos(a) * 31.2, 0, Math.sin(a) * 31.2), inward,
      lampPos: lamp.position.clone().add(new THREE.Vector3(-Math.cos(a), -0.6, -Math.sin(a)).multiplyScalar(1.2)), chase, back,
    };
  });
  const bossGate = gateObjs.find((g) => g.def.kind === 'boss')!;

  // ---- puffs + boss floor strobe -----------------------------------------------------------
  const puffs = createPuffs(rand);
  group.add(puffs.points);
  const strobe = createFloorStrobe(bossGate.def.angle);
  group.add(strobe.mesh);
  const puffAt = new THREE.Vector3();
  const gatePuff = (g: Gate, n: number, size: number, speed: number) => {
    const boss = g.def.kind === 'boss';
    puffAt.copy(g.mouth).setY(boss ? 1.6 : 1.1);
    puffs.emit(puffAt, g.inward, n, { spread: boss ? 3.2 : 1.6, speed, life: boss ? 2.6 : 1.8, size, up: 0.35 });
  };

  let league: LeagueStyle | null = null;
  let time = 0;
  let bossSeq = -1;

  function setSpots(ls: LeagueStyle): void {
    towers.forEach((t, i) => {
      const used = i < ls.towers;
      t.group.visible = used;
      t.shaft.group.visible = used;
      t.pool.mesh.visible = used;
      const wantSpot = used && i < ls.spots;
      if (wantSpot && !t.spot) {
        const s = new THREE.SpotLight(ls.floodColor, SPOT_INTENSITY, 90, SPOT_ANGLE, 0.6, 2);
        s.castShadow = false;
        s.position.copy(t.lampPos);
        s.target.position.copy(t.aim);
        scene.add(s, s.target);
        t.spot = s;
      } else if (!wantSpot && t.spot) {
        scene.remove(t.spot, t.spot.target);
        t.spot.dispose();
        t.spot = null;
      }
      t.spot?.color.set(ls.floodColor);
      t.lampMat.color.set(ls.floodColor).multiplyScalar(glowLum(ls.floodColor, LUM.lamp));
      t.shaft.setColor(ls.floodColor);
      t.shaft.setIntensity(ls.shaftIntensity);
      t.pool.setColor(ls.floodColor);
      t.pool.setFog(ls.fogDensity);
    });
  }

  function swing(t: Tower, target: THREE.Vector3, dur: number, hold: number): void {
    t.from.copy(t.aim);
    t.to.copy(target);
    t.swingT = 0;
    t.swingDur = dur;
    t.holdT = hold;
  }

  function nearestGate(p: THREE.Vector3): Gate | null {
    let best: Gate | null = null;
    let bd = Infinity;
    for (const g of gateObjs) {
      if (g.def.kind !== 'mob') continue;
      const a = THREE.MathUtils.degToRad(g.def.angle);
      const d = (p.x - Math.cos(a) * 29) ** 2 + (p.z - Math.sin(a) * 29) ** 2;
      if (d < bd) { bd = d; best = g; }
    }
    return bd < 64 ? best : null;
  }

  function claimLight(g: Gate): void {
    if (lightOwner.includes(g)) return;
    let idx = lightOwner.findIndex((o) => !o || o.alertT <= 0);
    if (idx < 0) idx = 0;
    lightOwner[idx] = g;
    gateLights[idx].position.copy(g.lampPos);
  }

  const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

  return {
    group,
    puffs,
    setLeague(ls) {
      league = ls;
      setSpots(ls);
    },
    telegraph(p) {
      const g = nearestGate(p);
      if (!g) return;
      const fresh = g.alertT <= 0.3;
      g.alertT = 1.6;
      g.holdOpen = 1.5;
      g.openTime = 0.32; // airlock kicks open
      if (fresh || g.open < 0.5) g.jolt = 0;
      gatePuff(g, fresh ? 16 : 8, 1.3, 3.2);
      claimLight(g);
    },
    bossEntrance() {
      bossSeq = 0;
      bossGate.alertT = 5.5;
      bossGate.openTime = 1.1;
      claimLight(bossGate);
      strobe.play(5);
      const a = THREE.MathUtils.degToRad(bossGate.def.angle);
      const target = new THREE.Vector3(Math.cos(a) * 24, 0, Math.sin(a) * 24);
      for (const t of towers) if (t.group.visible) swing(t, target, 1.2, 3.5);
    },
    spotlight(p, count, seconds) {
      const used = towers.filter((t) => t.group.visible).sort((a, b) => a.lampPos.distanceToSquared(p) - b.lampPos.distanceToSquared(p));
      for (const t of used.slice(0, count)) swing(t, new THREE.Vector3(p.x, 0, p.z), 0.5, seconds);
    },
    update(dt) {
      time += dt;
      const ls = league;
      // towers: swings + flicker
      for (let i = 0; i < towers.length; i++) {
        const t = towers[i];
        if (!t.group.visible) continue;
        if (t.swingDur > 0) {
          t.swingT += dt;
          const k = Math.min(1, t.swingT / t.swingDur);
          t.aim.lerpVectors(t.from, t.to, ease(k));
          if (k >= 1) {
            t.holdT -= dt;
            if (t.holdT <= 0) {
              if (t.to.equals(t.home)) t.swingDur = 0;
              else swing(t, t.home, 1.5, 0);
            }
          }
          t.shaft.aim(t.aim);
          t.pool.aim(t.aim);
          if (t.spot) t.spot.target.position.copy(t.aim);
        }
        let on = 1;
        if (ls?.flicker && i === 1) {
          t.nextFlicker -= dt;
          if (t.nextFlicker <= 0) {
            t.dropout = 0.3;
            t.nextFlicker = 8 + Math.random() * 12;
          }
          if (t.dropout > 0) {
            t.dropout -= dt;
            on = Math.sin(time * 80) > 0.3 ? 0.15 : 0.02;
          }
        }
        if (t.spot) t.spot.intensity = SPOT_INTENSITY * on;
        t.shaft.setIntensity((ls?.shaftIntensity ?? 0.12) * on);
        // overlapping pools (swings onto one point, legendary spectacle) share the light
        // instead of stacking additively into a burnt-white floor
        let overlap = 0;
        for (let j = 0; j < towers.length; j++) {
          const o = towers[j];
          if (j === i || !o.group.visible) continue;
          const d = Math.hypot(o.aim.x - t.aim.x, o.aim.z - t.aim.z);
          overlap += 1 - THREE.MathUtils.smoothstep(d, POOL_RADIUS * 0.6, POOL_RADIUS * 1.8);
        }
        t.pool.setIntensity((POOL_I * on) / (1 + overlap));
        t.shaft.update(time);
        if (ls) t.lampMat.color.set(ls.floodColor).multiplyScalar(glowLum(ls.floodColor, LUM.lamp) * (0.2 + 0.8 * on));
      }

      // boss sequence: doors open after the spots arrive (with a big haze breath)
      if (bossSeq >= 0) {
        const prev = bossSeq;
        bossSeq += dt;
        if (bossSeq > 1.2) bossGate.holdOpen = Math.max(bossGate.holdOpen, 0.1);
        if (prev < 1.2 && bossSeq >= 1.2) {
          bossGate.jolt = 0;
          gatePuff(bossGate, 46, 2.6, 5);
        }
        if (prev < 2.0 && bossSeq >= 2.0) gatePuff(bossGate, 24, 2.2, 3);
        if (bossSeq > 6) bossSeq = -1;
      }
      strobe.update(dt);
      puffs.update(dt);

      // gates
      for (const g of gateObjs) {
        const alert = g.alertT > 0;
        if (alert) g.alertT -= dt;
        let want = 0;
        if (g.holdOpen > 0) {
          g.holdOpen -= dt;
          want = g.def.kind === 'boss' && bossSeq >= 0 && bossSeq < 1.2 ? 0 : 1;
        }
        if (g.def.kind === 'boss' && bossSeq >= 1.2) want = 1;
        const wasOpen = g.open;
        const speed = want > g.open ? g.openTime : 0.6;
        g.open += THREE.MathUtils.clamp(want - g.open, -dt / speed, dt / speed);
        if (wasOpen > 0 && g.open <= 0) {
          g.jolt = 0; // slam shut
          g.openTime = 0.6;
        }
        g.jolt += dt;
        // jolt: a short decaying shudder of the door leaves (open kick and slam)
        const jk = g.jolt < 0.3 ? 1 - g.jolt / 0.3 : 0;
        const shudder = jk * jk * Math.sin(g.jolt * 95);
        const boss = g.def.kind === 'boss';
        for (const d of g.doors) {
          const sx = d.userData.sx as number;
          d.position.x = (d.userData.base as number) + sx * g.doorShift * ease(g.open) + shudder * (boss ? 0.09 : 0.06);
          d.position.y = d.scale.y / 2 + Math.abs(shudder) * (boss ? 0.05 : 0.035);
        }
        const backT = alert ? 1 : 0;
        g.back.value += (backT - g.back.value) * Math.min(1, dt * (alert ? 12 : 2.5));
        if (alert) {
          // hard strobe (8 Hz), brightest in the first second
          const on = Math.sin(time * Math.PI * 2 * 8) > 0 ? 1 : 0.12;
          g.lampMat.color.copy(threatLamp).multiplyScalar(on * (g.alertT > 0.6 ? 1 : 0.6));
        } else {
          g.lampMat.color.copy(idleLamp);
        }
        if (g.chase.length) {
          for (let k = 0; k < g.chase.length; k++) {
            const lit = alert && Math.floor(time * 12 - k) % 4 === 0;
            g.chase[k].color.copy(lit ? threatLamp : idleLamp);
          }
        }
      }
      for (let i = 0; i < gateLights.length; i++) {
        const o = lightOwner[i];
        const l = gateLights[i];
        if (o && o.alertT > 0) {
          const on = Math.sin(time * Math.PI * 2 * 8) > 0 ? 1 : 0.15;
          l.intensity = (o.def.kind === 'boss' ? 70 : 34) * on;
        } else {
          l.intensity = 0;
          if (o && o.alertT <= 0) lightOwner[i] = null;
        }
      }
      void tmpV;
    },
  };
}
