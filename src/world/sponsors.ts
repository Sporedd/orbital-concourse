/**
 * Sponsor plates (docs/ART_DIRECTION.md §7 "Sponsor plates use the weapon manufacturer words"):
 *  - painted stencil plaques on the arena wall (all leagues): lit, non-emissive steel plates
 *    with BONE stencil type and a thin accent tab, drawn into a canvas map;
 *  - LED dot-matrix sponsor billboards on the second tier face (Iron and up, more per league),
 *    accent + BONE at board luminance, same LED shader as the scoreboard.
 * Canvases redraw when the league changes and once the web fonts are ready. Headless (no 2D
 * canvas) the plates are not built at all.
 */
import * as THREE from 'three';
import { makeSurface } from '@/rendering/materials';
import { PALETTE, SPONSOR_WORDS, css, type LeagueStyle } from '@/rendering/style';
import { ACCENT_INK, BONE_INK, LedSurface, MONO, STENCIL, canDraw2d } from './boards';
import { DIM, TIERS } from './props';

/** Wall plaque angles: wall panel centres between the gates (vents use 22.5 + 90k). */
export const PLAQUE_ANGLES = [67.5, 157.5, 247.5, 337.5];
/** Tier-1 billboard angles in show order (between pillars, clear of vomitories and the boss gate). */
const BILLBOARD_ANGLES = [90, 0, 180, 60, 120, 240, 300, 30, 150, 210, 330];
const BILLBOARDS_BY_LEAGUE: Record<string, number> = { scrap: 0, iron: 4, steel: 6, star: 9, void: 11 };

const TAGLINES = ['OFFICIAL ARMS', 'ARENA PARTNER', 'MUNITIONS', 'PIT SUPPLIER', 'ORBITAL GRADE'];

export interface Sponsors {
  readonly group: THREE.Group;
  setLeague(ls: LeagueStyle): void;
  /** Flash the billboards (legendary drop, boss kill). */
  flash(seconds: number): void;
  update(dt: number): void;
}

interface Plaque {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  word: string;
  tag: string;
}

interface Billboard {
  mesh: THREE.Group;
  led: LedSurface;
  word: string;
  tag: string;
}

function drawPlaque(p: Plaque, accent: number): void {
  const { g, canvas } = p;
  const w = canvas.width, h = canvas.height;
  // worn steel-dark plate
  g.fillStyle = css(PALETTE.STEEL_DARK);
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 260; i++) {
    const v = 30 + Math.floor(Math.random() * 30);
    g.fillStyle = `rgba(${v},${v + 2},${v + 5},0.35)`;
    g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 6, 1 + Math.random() * 2);
  }
  // hairline border + rivets
  g.strokeStyle = css(PALETTE.BONE);
  g.globalAlpha = 0.55;
  g.lineWidth = 3;
  g.strokeRect(10, 10, w - 20, h - 20);
  g.globalAlpha = 0.8;
  g.fillStyle = '#8e8c86';
  for (const [x, y] of [[22, 22], [w - 22, 22], [22, h - 22], [w - 22, h - 22]]) {
    g.beginPath();
    g.arc(x, y, 4, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  // accent tab (hazard stripes) on the left
  const tabW = 46;
  g.save();
  g.beginPath();
  g.rect(28, 28, tabW, h - 56);
  g.clip();
  g.fillStyle = css(PALETTE.SHADOW);
  g.fillRect(28, 28, tabW, h - 56);
  g.fillStyle = css(accent);
  for (let y = -tabW; y < h; y += 22) {
    g.beginPath();
    g.moveTo(28, y);
    g.lineTo(28 + tabW, y - tabW);
    g.lineTo(28 + tabW, y - tabW + 11);
    g.lineTo(28, y + 11);
    g.fill();
  }
  g.restore();
  // stencil word
  g.fillStyle = css(PALETTE.BONE);
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  let px = 96;
  g.font = `${px}px ${STENCIL}`;
  const maxW = w - tabW - 80;
  while (px > 30 && g.measureText(p.word).width > maxW) {
    px -= 4;
    g.font = `${px}px ${STENCIL}`;
  }
  g.fillText(p.word, 28 + tabW + 22, h * 0.44);
  g.font = `700 22px ${MONO}`;
  g.globalAlpha = 0.75;
  g.fillText(p.tag, 28 + tabW + 24, h * 0.8);
  g.globalAlpha = 1;
  // scuffs across the paint
  g.globalCompositeOperation = 'multiply';
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(60,60,60,${0.15 + Math.random() * 0.25})`;
    g.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * 30, 1 + Math.random() * 3);
  }
  g.globalCompositeOperation = 'source-over';
  p.tex.needsUpdate = true;
}

function drawBillboard(b: Billboard): void {
  b.led.draw((g, w, h) => {
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    // accent block mark
    g.fillStyle = ACCENT_INK;
    g.fillRect(3, 4, 3, h - 8);
    g.fillRect(8, 4, 3, h - 8);
    g.fillStyle = ACCENT_INK;
    let px = 20;
    g.font = `${px}px ${STENCIL}`;
    while (px > 8 && g.measureText(b.word).width > w - 22) {
      px -= 1;
      g.font = `${px}px ${STENCIL}`;
    }
    g.fillText(b.word, 15, h * 0.4);
    g.fillStyle = BONE_INK;
    g.font = `700 6px ${MONO}`;
    g.fillText(b.tag, 16, h * 0.84);
  });
}

export function createSponsors(): Sponsors {
  const group = new THREE.Group();
  group.name = 'world-sponsors';
  const plaques: Plaque[] = [];
  const billboards: Billboard[] = [];
  let league: LeagueStyle | null = null;
  let flashT = 0;

  if (canDraw2d()) {
    // ---- wall plaques (painted, lit) ---------------------------------------------------
    const plaqueGeo = new THREE.PlaneGeometry(3.4, 0.85);
    PLAQUE_ANGLES.forEach((deg, i) => {
      const canvas = document.createElement('canvas');
      canvas.width = 1024;
      canvas.height = 256;
      let g: CanvasRenderingContext2D | null = null;
      try { g = canvas.getContext('2d'); } catch { g = null; }
      if (!g) return;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const mat = makeSurface({ color: 0xffffff, surface: 'paint', mottle: 0.05 });
      mat.map = tex;
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -1;
      mat.polygonOffsetUnits = -1;
      const m = new THREE.Mesh(plaqueGeo, mat);
      const a = THREE.MathUtils.degToRad(deg);
      const r = DIM.wallIn - 0.025;
      m.position.set(Math.cos(a) * r, 2.75, Math.sin(a) * r);
      m.rotation.y = -Math.PI / 2 - a; // face the centre
      m.receiveShadow = true;
      group.add(m);
      plaques.push({ canvas, g, tex, word: SPONSOR_WORDS[(i * 2) % SPONSOR_WORDS.length], tag: TAGLINES[i % TAGLINES.length] });
    });

    // ---- LED billboards on the tier-1 face --------------------------------------------
    const t1 = TIERS[1];
    const bh = t1.faceTop - t1.faceBottom - 0.4;
    const bw = 6.4;
    const geo = new THREE.PlaneGeometry(bw, bh);
    const housingMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.STEEL_DARK).multiplyScalar(0.55) });
    const housingGeo = new THREE.BoxGeometry(bw + 0.3, bh + 0.25, 0.2);
    BILLBOARD_ANGLES.forEach((deg, i) => {
      const led = new LedSurface(128, 28);
      const mesh = new THREE.Group();
      const a = THREE.MathUtils.degToRad(deg);
      const r = t1.r0 - 0.2;
      const face = new THREE.Mesh(geo, led.material);
      const housing = new THREE.Mesh(housingGeo, housingMat);
      housing.position.z = -0.11;
      mesh.add(housing, face);
      mesh.position.set(Math.cos(a) * r, (t1.faceBottom + t1.faceTop) / 2, Math.sin(a) * r);
      mesh.rotation.y = -Math.PI / 2 - a;
      mesh.visible = false;
      group.add(mesh);
      billboards.push({ mesh, led, word: SPONSOR_WORDS[(i * 3 + 1) % SPONSOR_WORDS.length], tag: `${TAGLINES[(i + 2) % TAGLINES.length]} · SEASON 01` });
    });
  }

  const redraw = () => {
    if (!league) return;
    for (const p of plaques) drawPlaque(p, league.accent);
    for (const b of billboards) {
      b.led.setColors(PALETTE.BONE, league.accent);
      drawBillboard(b);
    }
  };
  if (plaques.length && typeof document !== 'undefined' && document.fonts) {
    void document.fonts.ready.then(() => redraw());
  }

  return {
    group,
    setLeague(ls) {
      league = ls;
      const n = BILLBOARDS_BY_LEAGUE[ls.id] ?? 0;
      billboards.forEach((b, i) => { b.mesh.visible = i < n; });
      redraw();
    },
    flash(seconds) {
      flashT = Math.max(flashT, seconds);
    },
    update(dt) {
      if (!billboards.length) return;
      flashT = Math.max(0, flashT - dt);
      const f = flashT > 0 ? (Math.sin(flashT * 26) > 0 ? 0.7 : 0) : 0;
      for (const b of billboards) b.led.material.uniforms.uFlash.value = f;
    },
  };
}
