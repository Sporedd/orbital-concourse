/**
 * LED dot-matrix boards (docs/ART_DIRECTION.md §7 "Scoreboard and LED boards"): no holograms.
 * Content is drawn into a small canvas (one pixel per LED); the shader masks each cell to a
 * round dot. Two channels keep anti-aliasing: R = BONE coverage, G = accent coverage, each
 * scaled so the lit dots sit at lum 0.9 (just under the bloom threshold). fog: true.
 * Headless (no document / no 2D context): boards still build, they just stay dark.
 */
import * as THREE from 'three';
import { PALETTE, glowLum, type LeagueStyle } from '@/rendering/style';

const vert = /* glsl */ `
varying vec2 vUv;
#include <fog_pars_vertex>
void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const frag = /* glsl */ `
uniform sampler2D uMap;
uniform vec2 uRes;
uniform vec2 uScroll;
uniform vec3 uBone;
uniform vec3 uAccent;
uniform float uFlash;
varying vec2 vUv;
#include <fog_pars_fragment>
void main() {
  vec2 cell = vUv * uRes;
  vec2 id = floor( cell );
  vec2 f = fract( cell ) - 0.5;
  vec2 suv = ( id + 0.5 ) / uRes + uScroll;
  vec4 t = texture2D( uMap, suv );
  float dotm = smoothstep( 0.45, 0.3, length( f ) );
  vec3 col = ( uBone * t.r + uAccent * t.g ) * dotm * ( 1.0 + uFlash );
  col += vec3( 0.012, 0.013, 0.014 ) * dotm; // unlit LEDs read as a dark grid
  gl_FragColor = vec4( col, 1.0 );
  #include <fog_fragment>
}
`;

/** False headless and under jsdom (no 2D canvas without the native package). */
export function canDraw2d(): boolean {
  if (typeof document === 'undefined') return false;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return !/jsdom/i.test(ua);
}

export class LedSurface {
  readonly canvas: HTMLCanvasElement | null = null;
  readonly g: CanvasRenderingContext2D | null = null;
  readonly texture: THREE.Texture;
  readonly material: THREE.ShaderMaterial;

  constructor(readonly w: number, readonly h: number, scroll = false) {
    if (canDraw2d()) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      let g: CanvasRenderingContext2D | null = null;
      try {
        g = c.getContext('2d');
      } catch {
        g = null;
      }
      if (g) {
        this.canvas = c;
        this.g = g;
      }
    }
    if (this.canvas) {
      this.texture = new THREE.CanvasTexture(this.canvas);
    } else {
      this.texture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
      this.texture.needsUpdate = true;
    }
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    if (scroll) this.texture.wrapS = THREE.RepeatWrapping;
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uMap: { value: null },
      uRes: { value: new THREE.Vector2(w, h) },
      uScroll: { value: new THREE.Vector2() },
      uBone: { value: new THREE.Color() },
      uAccent: { value: new THREE.Color() },
      uFlash: { value: 0 },
    }]);
    uniforms.uMap.value = this.texture;
    this.material = new THREE.ShaderMaterial({ uniforms, vertexShader: vert, fragmentShader: frag, fog: true });
    this.setColors(PALETTE.BONE, 0xff5f1f);
  }

  setColors(bone: number, accent: number): void {
    const u = this.material.uniforms;
    (u.uBone.value as THREE.Color).set(bone).multiplyScalar(glowLum(bone, 0.9));
    (u.uAccent.value as THREE.Color).set(accent).multiplyScalar(glowLum(accent, 0.9));
  }

  /** Draw with a clean black canvas; colours: 'bone' → R, 'accent' → G. */
  draw(fn: (g: CanvasRenderingContext2D, w: number, h: number) => void): void {
    const g = this.g;
    if (!g) return;
    g.save();
    g.fillStyle = '#000';
    g.fillRect(0, 0, this.w, this.h);
    fn(g, this.w, this.h);
    g.restore();
    this.texture.needsUpdate = true;
  }
}

export const BONE_INK = '#ff0000';
export const ACCENT_INK = '#00ff00';
export const STENCIL = "'Saira Stencil One', 'Arial Black', sans-serif";
export const MONO = "'Martian Mono', 'Consolas', monospace";

export interface BoardState {
  round: number;
  hostiles: number;
  playerName: string;
  rankTitle: string;
  boss: string | null;
  hype: number;
  league: string;
}

export interface Boards {
  readonly group: THREE.Group;
  setLeague(ls: LeagueStyle): void;
  /** Force a redraw on the next update (state changed). */
  dirty(): void;
  /** Show a takeover message for `seconds` (LEGENDARY, HEADLINER, …). */
  takeover(lines: [string, string], seconds: number): void;
  /** Flash the gate ribbons (legendary drop / round start). */
  flashRibbons(seconds: number): void;
  update(dt: number, s: BoardState): void;
}

function fitText(g: CanvasRenderingContext2D, text: string, font: (px: number) => string, maxW: number, px: number): void {
  let size = px;
  g.font = font(size);
  while (size > 6 && g.measureText(text).width > maxW) {
    size -= 1;
    g.font = font(size);
  }
}

export function createBoards(gates: { angle: number; kind: string }[]): Boards {
  const group = new THREE.Group();
  group.name = 'world-boards';

  // ---- hanging scoreboard (2 faces for Scrap/Iron, 4-face cube for Steel+) --------------
  const BW = 6, BH = 3;
  const score = new LedSurface(96, 48);
  const housingMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.STEEL_DARK).multiplyScalar(0.6) });
  const board = new THREE.Group();
  board.position.set(0, 20, 0);
  const housing = new THREE.Mesh(new THREE.BoxGeometry(BW + 0.3, BH + 0.4, BW + 0.3), housingMat);
  board.add(housing);
  const faces: THREE.Mesh[] = [];
  const faceGeo = new THREE.PlaneGeometry(BW, BH);
  for (let i = 0; i < 4; i++) {
    const m = new THREE.Mesh(faceGeo, score.material);
    const a = (i * Math.PI) / 2;
    m.position.set(Math.sin(a) * (BW / 2 + 0.16), 0, Math.cos(a) * (BW / 2 + 0.16));
    m.rotation.y = a;
    faces.push(m);
    board.add(m);
  }
  // cables to the trusses
  const cableMat = new THREE.MeshBasicMaterial({ color: 0x15171a });
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(0.05, 6, 0.05), cableMat);
    c.position.set(sx * 2.6, BH / 2 + 3, sz * 2.6);
    board.add(c);
  }
  group.add(board);

  // ---- gate ribbons --------------------------------------------------------------------
  const ribbon = new LedSurface(256, 14, true);
  const bossRibbon = new LedSurface(256, 14, true);
  const ribbonGeo = new THREE.PlaneGeometry(6.4, 0.7);
  const bossGeo = new THREE.PlaneGeometry(14, 0.9);
  for (const gt of gates) {
    const a = THREE.MathUtils.degToRad(gt.angle);
    const boss = gt.kind === 'boss';
    const r = boss ? 30.1 : 30.15;
    const m = new THREE.Mesh(boss ? bossGeo : ribbonGeo, boss ? bossRibbon.material : ribbon.material);
    m.position.set(Math.cos(a) * r, boss ? 11.4 : 6.25, Math.sin(a) * r);
    m.rotation.y = -Math.PI / 2 - a; // face the centre
    group.add(m);
    // housing strip
    const hz = new THREE.Mesh(new THREE.BoxGeometry(boss ? 14.3 : 6.7, boss ? 1.1 : 0.9, 0.25), housingMat);
    hz.position.copy(m.position).addScaledVector(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), 0.14);
    hz.rotation.y = m.rotation.y;
    group.add(hz);
  }

  let page = 0;
  let pageT = 0;
  let needs = true;
  let takeoverT = 0;
  let takeoverLines: [string, string] = ['', ''];
  let ribbonFlash = 0;
  let scroll = 0;
  let lastKey = '';
  let ribbonKey = '';
  let fontsReady = false;
  if (typeof document !== 'undefined' && (document as Document & { fonts?: FontFaceSet }).fonts) {
    void document.fonts.ready.then(() => {
      fontsReady = true;
      needs = true;
      ribbonKey = '';
    });
  }

  function drawPage(s: BoardState): void {
    score.draw((g, w, h) => {
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      if (takeoverT > 0) {
        g.fillStyle = ACCENT_INK;
        fitText(g, takeoverLines[0], (px) => `${px}px ${STENCIL}`, w - 6, 22);
        g.fillText(takeoverLines[0], w / 2, h * 0.36);
        g.fillStyle = BONE_INK;
        fitText(g, takeoverLines[1], (px) => `700 ${px}px ${MONO}`, w - 6, 9);
        g.fillText(takeoverLines[1], w / 2, h * 0.78);
        return;
      }
      const pages = s.boss ? 3 : 3;
      const p = page % pages;
      if (s.boss && p !== 1) {
        g.fillStyle = BONE_INK;
        g.font = `700 8px ${MONO}`;
        g.fillText('HEADLINER', w / 2, h * 0.2);
        g.fillStyle = ACCENT_INK;
        const name = s.boss.toUpperCase();
        fitText(g, name, (px) => `${px}px ${STENCIL}`, w - 6, 18);
        g.fillText(name, w / 2, h * 0.6);
        return;
      }
      if (p === 0 || (s.boss && p === 1)) {
        g.fillStyle = BONE_INK;
        g.font = `700 8px ${MONO}`;
        g.fillText('ROUND', w / 2, h * 0.16);
        g.fillStyle = ACCENT_INK;
        g.font = `26px ${STENCIL}`;
        g.fillText(String(Math.max(1, s.round)).padStart(2, '0'), w / 2, h * 0.5);
        g.fillStyle = BONE_INK;
        g.font = `700 8px ${MONO}`;
        g.fillText(`HOSTILES ${String(Math.max(0, s.hostiles)).padStart(2, '0')}`, w / 2, h * 0.86);
      } else if (p === 1) {
        g.fillStyle = BONE_INK;
        const nm = s.playerName.toUpperCase();
        fitText(g, nm, (px) => `700 ${px}px ${MONO}`, w - 6, 10);
        g.fillText(nm, w / 2, h * 0.3);
        g.fillStyle = ACCENT_INK;
        const rt = s.rankTitle.toUpperCase();
        fitText(g, rt, (px) => `${px}px ${STENCIL}`, w - 6, 16);
        g.fillText(rt, w / 2, h * 0.68);
      } else {
        g.fillStyle = BONE_INK;
        g.font = `700 8px ${MONO}`;
        g.fillText('CROWD HYPE', w / 2, h * 0.2);
        g.fillStyle = ACCENT_INK;
        g.font = `22px ${STENCIL}`;
        g.fillText(`×${Math.max(1, Math.round(1 + s.hype * 4))}`, w / 2, h * 0.58);
        // 10-segment gauge
        const segs = 10;
        const on = Math.round(s.hype * segs);
        for (let i = 0; i < segs; i++) {
          g.fillStyle = i < on ? ACCENT_INK : '#002000';
          g.fillRect(8 + i * 8, h - 8, 6, 4);
        }
      }
    });
  }

  function drawRibbons(s: BoardState): void {
    const text = `  Orbital Concourse  ·  ${s.league}  ·  ROUND ${String(Math.max(1, s.round)).padStart(2, '0')}  ·  JAKKO  ·  VEXLIN  ·  ${s.playerName.toUpperCase()}  ·  KORD ARMS  ·`;
    ribbon.draw((g, w, h) => {
      g.textBaseline = 'middle';
      g.font = `700 10px ${MONO}`;
      let x = 0;
      let i = 0;
      const parts = text.split('·');
      while (x < w) {
        const t = parts[i % parts.length];
        g.fillStyle = i % 2 ? ACCENT_INK : BONE_INK;
        g.fillText(t, x, h / 2 + 1);
        x += g.measureText(t).width;
        g.fillStyle = ACCENT_INK;
        g.fillText('·', x, h / 2 + 1);
        x += g.measureText('·').width;
        i++;
      }
    });
    bossRibbon.draw((g, w, h) => {
      g.textBaseline = 'middle';
      g.font = `700 10px ${MONO}`;
      const t = s.boss ? `HEADLINER · ${s.boss.toUpperCase()} · ` : 'HEADLINER GATE · NO ENTRY · ';
      let x = 0;
      let i = 0;
      while (x < w) {
        g.fillStyle = s.boss ? ACCENT_INK : i % 2 ? ACCENT_INK : BONE_INK;
        g.fillText(t, x, h / 2 + 1);
        x += g.measureText(t).width;
        i++;
      }
    });
  }

  return {
    group,
    setLeague(ls) {
      for (const s of [score, ribbon, bossRibbon]) s.setColors(PALETTE.BONE, ls.accent);
      faces[1].visible = faces[3].visible = ls.cubeBoard;
      housing.scale.set(1, 1, ls.cubeBoard ? 1 : 0.06);
      if (!ls.cubeBoard) {
        faces[0].position.z = 0.35;
        faces[2].position.z = -0.35;
      } else {
        faces[0].position.z = BW / 2 + 0.16;
        faces[2].position.z = -(BW / 2 + 0.16);
      }
      needs = true;
      ribbonKey = '';
    },
    dirty() {
      needs = true;
    },
    takeover(lines, seconds) {
      takeoverLines = lines;
      takeoverT = seconds;
      needs = true;
    },
    flashRibbons(seconds) {
      ribbonFlash = seconds;
    },
    update(dt, s) {
      pageT += dt;
      if (pageT > 4) {
        pageT = 0;
        page++;
        needs = true;
      }
      if (takeoverT > 0) {
        takeoverT -= dt;
        if (takeoverT <= 0) needs = true;
      }
      const key = `${s.round}|${s.hostiles}|${s.boss}|${Math.round(s.hype * 10)}|${s.rankTitle}|${fontsReady}`;
      if (key !== lastKey) {
        lastKey = key;
        needs = true;
      }
      if (needs) {
        needs = false;
        drawPage(s);
      }
      const rk = `${s.round}|${s.boss}|${s.league}|${fontsReady}`;
      if (rk !== ribbonKey) {
        ribbonKey = rk;
        drawRibbons(s);
      }
      scroll = (scroll + dt * 0.035) % 1;
      (ribbon.material.uniforms.uScroll.value as THREE.Vector2).x = scroll;
      (bossRibbon.material.uniforms.uScroll.value as THREE.Vector2).x = scroll * 0.7;
      board.rotation.y += dt * 0.0; // static (cube faces cover all sides)
      ribbonFlash = Math.max(0, ribbonFlash - dt);
      const fl = ribbonFlash > 0 ? (Math.sin(ribbonFlash * 30) > 0 ? 0.8 : 0) : 0;
      ribbon.material.uniforms.uFlash.value = fl;
      bossRibbon.material.uniforms.uFlash.value = fl;
      score.material.uniforms.uFlash.value = takeoverT > 0 ? 0.15 : 0;
    },
  };
}
