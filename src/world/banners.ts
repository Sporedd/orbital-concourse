/**
 * Tattered sponsor banners (grimdark revision, docs/ART_DIRECTION.md §15): long cloth drops
 * hung from steel poles between the pillars, above the wall coping. Dark oxblood cloth, a
 * league-accent band, our own geometric pit crest (chevrons in a ring: no skulls, no eagles)
 * and a sponsor word in stacked stencil letters; the hem is torn and holed (alpha-tested). The
 * cloth is lit (the braziers on the coping and the sodium spill pick it out of the dark) and
 * sways in the vertex shader. Headless (no 2D canvas) the banners are not built.
 */
import * as THREE from 'three';
import { makeSurface } from '@/rendering/materials';
import { GRIM, PALETTE, SPONSOR_WORDS, css, type LeagueStyle } from '@/rendering/style';
import { STENCIL, canDraw2d } from './boards';
import { DIM } from './props';

/** Banner angles in hanging order (between pillars, clear of the gates). */
const ANGLES = [30, 210, 120, 300, 60, 240, 150, 330, 15, 195, 105, 345];
const BW = 2.3;
const BH = 8.2;
const TOP = 14.6;

export interface Banners {
  readonly group: THREE.Group;
  setLeague(ls: LeagueStyle): void;
  update(dt: number): void;
}

function drawBanner(g: CanvasRenderingContext2D, w: number, h: number, word: string, accent: number, seed: number): void {
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  g.clearRect(0, 0, w, h);
  // cloth with vertical folds
  const grad = g.createLinearGradient(0, 0, w, 0);
  for (let i = 0; i <= 6; i++) {
    const v = 0.75 + 0.25 * Math.sin(i * 1.9 + seed);
    const c = new THREE.Color(GRIM.CLOTH).multiplyScalar(v);
    grad.addColorStop(i / 6, `#${c.getHexString()}`);
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  // black borders + accent band at the top
  g.fillStyle = '#0b0908';
  g.fillRect(0, 0, w, h * 0.035);
  g.fillRect(0, 0, w * 0.06, h);
  g.fillRect(w * 0.94, 0, w * 0.06, h);
  g.fillStyle = css(accent);
  g.globalAlpha = 0.85;
  g.fillRect(w * 0.06, h * 0.045, w * 0.88, h * 0.022);
  g.globalAlpha = 1;
  // pit crest: a ring with three stacked chevrons
  const cx = w / 2, cy = h * 0.17, R = w * 0.3;
  g.strokeStyle = css(PALETTE.BONE);
  g.fillStyle = css(PALETTE.BONE);
  g.globalAlpha = 0.82;
  g.lineWidth = w * 0.035;
  g.beginPath();
  g.arc(cx, cy, R, 0, Math.PI * 2);
  g.stroke();
  for (let k = 0; k < 3; k++) {
    const y = cy - R * 0.45 + k * R * 0.38;
    g.beginPath();
    g.moveTo(cx - R * 0.55, y);
    g.lineTo(cx, y + R * 0.3);
    g.lineTo(cx + R * 0.55, y);
    g.lineTo(cx + R * 0.55, y + R * 0.14);
    g.lineTo(cx, y + R * 0.44);
    g.lineTo(cx - R * 0.55, y + R * 0.14);
    g.closePath();
    g.fill();
  }
  // stacked stencil letters
  const letters = word.split('');
  const top = h * 0.32, bottom = h * 0.8;
  const step = Math.min(w * 0.62, (bottom - top) / letters.length);
  g.font = `${Math.floor(step * 0.95)}px ${STENCIL}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  letters.forEach((ch, i) => g.fillText(ch, cx, top + step * (i + 0.5)));
  g.globalAlpha = 1;
  // grime and stains
  g.globalCompositeOperation = 'multiply';
  for (let i = 0; i < 70; i++) {
    const v = 60 + Math.floor(rnd() * 90);
    g.fillStyle = `rgba(${v},${v * 0.8},${v * 0.7},${0.25 + rnd() * 0.4})`;
    const x = rnd() * w, y = rnd() * h;
    g.fillRect(x, y, 2 + rnd() * 8, 6 + rnd() * h * 0.08);
  }
  g.globalCompositeOperation = 'source-over';
  // torn hem and holes (alpha)
  g.globalCompositeOperation = 'destination-out';
  g.beginPath();
  g.moveTo(0, h);
  let x = 0;
  while (x < w) {
    const y = h * (0.86 + rnd() * 0.12);
    g.lineTo(x, y);
    x += w * (0.04 + rnd() * 0.1);
  }
  g.lineTo(w, h * (0.88 + rnd() * 0.1));
  g.lineTo(w, h);
  g.closePath();
  g.fill();
  for (let i = 0; i < 9; i++) {
    g.beginPath();
    const hx = w * (0.1 + rnd() * 0.8), hy = h * (0.25 + rnd() * 0.6), hr = w * (0.02 + rnd() * 0.06);
    g.ellipse(hx, hy, hr, hr * (1 + rnd() * 1.5), rnd() * 3, 0, Math.PI * 2);
    g.fill();
  }
  // ragged side edges
  for (let y = 0; y < h; y += 14) {
    if (rnd() < 0.3) g.fillRect(0, y, w * 0.03 * rnd() * 2, 10);
    if (rnd() < 0.3) g.fillRect(w - w * 0.03 * rnd() * 2, y, w * 0.06, 10);
  }
  g.globalCompositeOperation = 'source-over';
}

export function createBanners(): Banners {
  const group = new THREE.Group();
  group.name = 'world-banners';
  const time = { value: 0 };
  const items: { mesh: THREE.Group; g: CanvasRenderingContext2D; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; word: string; seed: number }[] = [];
  let league: LeagueStyle | null = null;

  if (canDraw2d()) {
    const geo = new THREE.PlaneGeometry(BW, BH, 1, 10);
    geo.translate(0, -BH / 2, 0); // hangs from y = 0
    const poleGeo = new THREE.BoxGeometry(BW + 0.7, 0.14, 0.14);
    const poleMat = makeSurface({ color: GRIM.STEEL_DARK, surface: 'steel', rust: 0.6 });
    ANGLES.forEach((deg, i) => {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 512;
      let g: CanvasRenderingContext2D | null = null;
      try { g = canvas.getContext('2d'); } catch { g = null; }
      if (!g) return;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const mat = makeSurface({ color: 0xffffff, surface: 'paint', mottle: 0.06, flat: false });
      mat.map = tex;
      mat.alphaTest = 0.5;
      mat.side = THREE.DoubleSide;
      const base = mat.onBeforeCompile;
      const phase = i * 1.37;
      mat.onBeforeCompile = (shader, renderer) => {
        base.call(mat, shader, renderer);
        shader.uniforms.uSway = time;
        shader.uniforms.uPhase = { value: phase };
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uSway;\nuniform float uPhase;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
  {
    float hang = clamp( -position.y / ${BH.toFixed(2)}, 0.0, 1.0 );
    float w = sin( uSway * 0.9 + uPhase + hang * 2.2 ) * 0.22 + sin( uSway * 2.3 + uPhase * 2.0 + hang * 5.0 ) * 0.05;
    transformed.z += w * hang * hang;
    transformed.x += sin( uSway * 0.7 + uPhase ) * 0.08 * hang * hang;
  }`);
      };
      mat.customProgramCacheKey = () => 'concourse-banner-v1';
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = false;
      m.receiveShadow = true;
      const pole = new THREE.Mesh(poleGeo, poleMat);
      const holder = new THREE.Group();
      holder.add(m, pole);
      const a = THREE.MathUtils.degToRad(deg);
      const r = DIM.pillarR - 0.75;
      holder.position.set(Math.cos(a) * r, TOP, Math.sin(a) * r);
      holder.rotation.y = -Math.PI / 2 - a;
      holder.visible = false;
      group.add(holder);
      items.push({ mesh: holder, g, canvas, tex, word: SPONSOR_WORDS[(i * 5 + 2) % SPONSOR_WORDS.length], seed: i + 1 });
    });
  }

  const redraw = () => {
    if (!league) return;
    for (const it of items) {
      drawBanner(it.g, it.canvas.width, it.canvas.height, it.word, league.accent, it.seed);
      it.tex.needsUpdate = true;
    }
  };
  if (items.length && typeof document !== 'undefined' && document.fonts) void document.fonts.ready.then(() => redraw());

  return {
    group,
    setLeague(ls) {
      league = ls;
      items.forEach((it, i) => { it.mesh.visible = i < ls.banners; });
      redraw();
    },
    update(dt) {
      time.value = (time.value + dt) % 1000;
    },
  };
}
