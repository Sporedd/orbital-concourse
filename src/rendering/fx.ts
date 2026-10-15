/**
 * Pooled visual effects (docs/ART_DIRECTION.md §11): thin hot tracers, concrete impacts
 * (grey dust puff, hot sparks, flat chips, ragged scorch decal), explosions (white flash,
 * element-tinted fresnel shell, floor dust ring, local ground-haze puff, shake), particle
 * bursts, camera shake and an edge-only damage vignette (no full-screen flashes).
 * Nothing is allocated per effect after boot.
 */
import * as THREE from 'three';
import { createRng } from '@/core/rng';
import type { Fx, GameContext } from '@/core/types';
import { hazePuff } from './haze';
import { DebrisSystem, SparkSystem } from './particles';
import { lumLinear } from './style';

const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);

interface Tracer {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  from: THREE.Vector3;
  to: THREE.Vector3;
  width: number;
  t: number;
  life: number;
  active: boolean;
}

interface Decal {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  t: number;
  active: boolean;
  scale: number;
}

interface Explosion {
  core: THREE.Mesh;
  shell: THREE.Mesh;
  ring: THREE.Mesh;
  coreMat: THREE.ShaderMaterial;
  shellMat: THREE.ShaderMaterial;
  ringMat: THREE.ShaderMaterial;
  color: THREE.Color;
  light: THREE.PointLight;
  radius: number;
  t: number;
  active: boolean;
}

const TRACER_LIFE = 0.06;
const DECAL_LIFE = 9;
const EXPLOSION_LIFE = 1.5;
const FLASH_LIFE = 0.08;
const SHELL_LIFE = 0.25;
/**
 * Dust colour. The spec's #8E8C86 is the same value as key-lit concrete, so a puff of it on the
 * floor or a wall simply vanishes; dust in floodlight reads lighter than the surface it hangs in
 * front of (as in the concept frame), so it uses a lit, slightly warm grey.
 */
/** Grimdark: dust is dark warm grey (unlit sprites must not glow in the dark arena). */
const DUST = 0x4a433c;
/** Tracers never get thinner than this many radians on screen (~1.4 px at 720p, 85° fov). */
const TRACER_MIN_ANGLE = 0.0016;

/** Dark scorch square with ragged alpha (#1C1E21 at 60 %). No comic star. */
function makeDecalTexture(): THREE.Texture | null {
  if (typeof document === 'undefined' || (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent))) return null;
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (!g) return null;
  const img = g.createImageData(size, size);
  const rnd = createRng(0xdeca1);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = Math.abs(x - size / 2 + 0.5) / (size / 2);
      const dy = Math.abs(y - size / 2 + 0.5) / (size / 2);
      const sq = Math.max(dx, dy); // square falloff
      const ragged = 0.62 + rnd() * 0.3;
      let a = sq < ragged ? 1 : Math.max(0, 1 - (sq - ragged) / 0.08);
      a *= 0.75 + rnd() * 0.25;
      a *= 1 - 0.35 * Math.min(1, sq * 1.2);
      const i = (y * size + x) * 4;
      img.data[i] = 0x1c;
      img.data[i + 1] = 0x1e;
      img.data[i + 2] = 0x21;
      img.data[i + 3] = Math.round(255 * 0.6 * a);
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Flash sphere: white-hot centre fading to the limb, so the 0.08 s flash has no hard disc edge. */
const flashFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
varying vec3 vN;
varying vec3 vV;
void main() {
  float f = abs( dot( normalize( vN ), normalize( vV ) ) );
  float a = uAlpha * pow( f, 1.6 );
  gl_FragColor = vec4( uColor * a, a );
}
`;
const shellVert = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vV = normalize( -mv.xyz );
  vN = normalize( normalMatrix * normal );
  gl_Position = projectionMatrix * mv;
}
`;
const shellFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
varying vec3 vN;
varying vec3 vV;
void main() {
  float f = 1.0 - abs( dot( normalize( vN ), normalize( vV ) ) );
  float a = uAlpha * ( 0.15 + 0.85 * pow( f, 2.0 ) );
  gl_FragColor = vec4( uColor * a, a );
}
`;
const ringVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }
`;
const ringFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uInner;
varying vec2 vUv;
float h12( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
void main() {
  vec2 p = ( vUv - 0.5 ) * 2.0;
  float r = length( p );
  float band = smoothstep( uInner - 0.25, uInner, r ) * ( 1.0 - smoothstep( 0.8, 1.0, r ) );
  float n = 0.6 + 0.4 * h12( floor( p * 18.0 ) );
  float a = uAlpha * band * n;
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( uColor, a );
}
`;

export function createFxImpl(ctx: GameContext): Fx {
  const { scene, camera, renderer } = ctx;
  const rnd = createRng(0xf00d); // presentation-only randomness (not sim)

  const root = new THREE.Group();
  root.name = 'fx';
  scene.add(root);

  const sparks = new SparkSystem(3000);
  root.add(sparks.points);
  const dust = new SparkSystem(900, true);
  root.add(dust.points);
  const debris = new DebrisSystem(ctx.materials, 320);
  root.add(debris.mesh);

  // temporaries
  const tA = new THREE.Vector3();
  const tB = new THREE.Vector3();
  const tN = new THREE.Vector3();
  const tColor = new THREE.Color();
  const tColor2 = new THREE.Color();
  const camPos = new THREE.Vector3();
  const drawSize = new THREE.Vector2();
  let lastH = -1;
  let lastFov = -1;

  // ---- tracers --------------------------------------------------------------
  const tracerGeo = new THREE.BoxGeometry(1, 1, 1);
  tracerGeo.translate(0, 0, 0.5);
  const tracers: Tracer[] = [];
  for (let i = 0; i < 64; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    mat.userData.noInk = true;
    const mesh = new THREE.Mesh(tracerGeo, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 15;
    root.add(mesh);
    tracers.push({ mesh, mat, from: new THREE.Vector3(), to: new THREE.Vector3(), width: 0.016, t: 0, life: TRACER_LIFE, active: false });
  }
  let tracerHead = 0;

  // ---- decals ---------------------------------------------------------------
  const decalGeo = new THREE.PlaneGeometry(1, 1);
  const decalTex = makeDecalTexture();
  const decals: Decal[] = [];
  for (let i = 0; i < 64; i++) {
    const mat = new THREE.MeshBasicMaterial({
      map: decalTex,
      color: decalTex ? 0xffffff : 0x1c1e21,
      transparent: true,
      opacity: decalTex ? 1 : 0.6,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    mat.userData.noInk = true;
    const mesh = new THREE.Mesh(decalGeo, mat);
    mesh.visible = false;
    mesh.renderOrder = 5;
    root.add(mesh);
    decals.push({ mesh, mat, t: 0, active: false, scale: 0.25 });
  }
  let decalHead = 0;

  // ---- explosions -----------------------------------------------------------
  const sphereGeo = new THREE.IcosahedronGeometry(1, 2);
  const ringGeo = new THREE.PlaneGeometry(2, 2);
  ringGeo.rotateX(-Math.PI / 2);
  const explosions: Explosion[] = [];
  const lights: THREE.PointLight[] = [];
  for (let i = 0; i < 3; i++) {
    // fixed light count → no shader recompiles when explosions happen
    const l = new THREE.PointLight(0xffe2b0, 0, 10, 2);
    l.castShadow = false;
    root.add(l);
    lights.push(l);
  }
  for (let i = 0; i < 8; i++) {
    const coreMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uAlpha: { value: 0 } },
      vertexShader: shellVert,
      fragmentShader: flashFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const shellMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color() }, uAlpha: { value: 0 } },
      vertexShader: shellVert,
      fragmentShader: shellFrag,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      fog: false,
    });
    const ringMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(DUST) }, uAlpha: { value: 0 }, uInner: { value: 0.5 } },
      vertexShader: ringVert,
      fragmentShader: ringFrag,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const core = new THREE.Mesh(sphereGeo, coreMat);
    const shell = new THREE.Mesh(sphereGeo, shellMat);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    for (const m of [core, shell, ring]) {
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 16;
      root.add(m);
    }
    ring.renderOrder = 6;
    explosions.push({
      core, shell, ring, coreMat, shellMat, ringMat,
      color: new THREE.Color(), light: lights[i % lights.length], radius: 1, t: 0, active: false,
    });
  }
  let explosionHead = 0;

  // ---- shake ----------------------------------------------------------------
  let trauma = 0;
  let shakeTime = 0;
  const shakePos = new THREE.Vector3();
  const shakeRot = new THREE.Vector3();
  const lastCamPos = new THREE.Vector3();
  const lastCamRot = new THREE.Vector3();
  let shakeApplied = false;

  // ---- edge vignette (damage feedback; no full-screen fill) ----------------
  const flashEl = typeof document !== 'undefined' ? document.createElement('div') : null;
  if (flashEl) {
    flashEl.className = 'sb-edge';
    flashEl.style.cssText =
      'position:absolute;inset:0;pointer-events:none;opacity:0;z-index:5;' +
      'background:radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, currentColor 120%);';
    ctx.uiRoot.appendChild(flashEl);
  }
  let flashAlpha = 0;
  let flashDecay = 1.25;

  // ---- helpers --------------------------------------------------------------
  const floorAt = (x: number, z: number, y: number) => {
    const w = ctx.world;
    if (!w) return 0;
    const g = w.groundHeight(x, z);
    return g <= y + 0.2 ? g : 0;
  };

  /** random direction in a cone-ish hemisphere around n (written into out). */
  const randDir = (n: THREE.Vector3, spread: number, out: THREE.Vector3) => {
    out.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
    if (out.lengthSq() < 1e-4) out.set(0, 1, 0);
    out.normalize();
    if (out.dot(n) < 0) out.addScaledVector(n, -2 * out.dot(n));
    out.lerp(n, 1 - spread).normalize();
    return out;
  };

  /** Hot sparks: colour mixed toward white, at a luminance target (lum ≈ `lum`). */
  const spawnSparks = (p: THREE.Vector3, n: THREE.Vector3, color: number, count: number, speed: number, spread: number, lum: number, life: number, size: number, gravity = 1) => {
    tColor.setHex(color);
    for (let i = 0; i < count; i++) {
      randDir(n, spread, tA);
      const sp = speed * (0.4 + rnd() * 0.8);
      const white = 0.35 + rnd() * 0.4;
      const r = tColor.r * (1 - white) + white;
      const g = tColor.g * (1 - white) + white;
      const b = tColor.b * (1 - white) + white;
      const k = lum / Math.max(0.05, 0.2126 * r + 0.7152 * g + 0.0722 * b);
      sparks.spawn(p.x, p.y, p.z, tA.x * sp, tA.y * sp, tA.z * sp, r * k, g * k, b * k, life * (0.6 + rnd() * 0.8), size * (0.6 + rnd() * 0.8), gravity, 2.5);
    }
  };

  const spawnDust = (p: THREE.Vector3, n: THREE.Vector3, count: number, speed: number, life: number, size: number) => {
    tColor2.setHex(DUST);
    for (let i = 0; i < count; i++) {
      randDir(n, 0.9, tA);
      const sp = speed * (0.3 + rnd() * 0.7);
      const v = 0.85 + rnd() * 0.3;
      dust.spawn(p.x, p.y, p.z, tA.x * sp, tA.y * sp + 0.3, tA.z * sp, tColor2.r * v, tColor2.g * v, tColor2.b * v, life * (0.7 + rnd() * 0.6), size * (0.7 + rnd() * 0.6), -0.05, 3.5);
    }
  };

  const spawnDebris = (p: THREE.Vector3, n: THREE.Vector3, color: number, count: number, speed: number, size: number) => {
    const floor = floorAt(p.x, p.z, p.y);
    for (let i = 0; i < count; i++) {
      randDir(n, 0.8, tA);
      const sp = speed * (0.5 + rnd() * 0.8);
      debris.spawn(p.x, p.y, p.z, tA.x * sp, tA.y * sp + 1.5, tA.z * sp, color, size * (0.6 + rnd() * 0.8), 0.9 + rnd() * 0.8, floor, rnd);
    }
  };

  const placeDecal = (point: THREE.Vector3, normal: THREE.Vector3) => {
    const w = ctx.world;
    if (!w) return;
    // only stick decals to static world geometry (not to enemies)
    tB.copy(point).addScaledVector(normal, 0.08);
    tN.copy(normal).negate();
    const hit = w.raycast(tB, tN, 0.25);
    if (!hit) return;
    const d = decals[decalHead];
    decalHead = (decalHead + 1) % decals.length;
    d.active = true;
    d.t = 0;
    d.scale = 0.16 + rnd() * 0.12;
    d.mesh.visible = true;
    d.mat.opacity = 1;
    d.mesh.position.copy(hit.point).addScaledVector(hit.normal, 0.012);
    d.mesh.quaternion.setFromUnitVectors(FWD, hit.normal);
    d.mesh.rotateZ(rnd() * Math.PI * 2);
    d.mesh.scale.setScalar(d.scale);
  };

  const fx: Fx = {
    tracer(from, to, color, width = 0.03) {
      const tr = tracers[tracerHead];
      tracerHead = (tracerHead + 1) % tracers.length;
      tr.active = true;
      tr.t = 0;
      // thin: 0.012–0.02 m (callers' old default 0.03 → 0.016); wide arcs stay a little wider
      tr.width = width > 0.05 ? 0.03 : THREE.MathUtils.clamp(width * 0.55, 0.01, 0.02);
      tr.from.copy(from);
      tr.to.copy(to);
      // core: 70 % white + 30 % element colour at lum 2.5
      tColor.setHex(color);
      tr.mat.color.setRGB(0.7 + 0.3 * tColor.r, 0.7 + 0.3 * tColor.g, 0.7 + 0.3 * tColor.b);
      const l = 0.2126 * tr.mat.color.r + 0.7152 * tr.mat.color.g + 0.0722 * tr.mat.color.b;
      tr.mat.color.multiplyScalar(2.5 / Math.max(0.05, l));
      tr.mat.opacity = 1;
      tr.mesh.visible = true;
      camera.getWorldPosition(camPos);
      applyTracer(tr);
    },

    impact(point, normal, color) {
      tN.copy(normal);
      if (tN.lengthSq() < 1e-6) tN.copy(UP);
      tN.normalize();
      // concrete: grey dust puff, 6–10 hot sparks, 3 chips, scorch decal
      spawnDust(point, tN, 5, 1.2, 0.3, 0.32);
      spawnSparks(point, tN, color, 6 + Math.floor(rnd() * 5), 7, 0.65, 3.0, 0.25, 0.04, 1.2);
      spawnDebris(point, tN, 0x34302c, 3, 3, 0.045);
      placeDecal(point, tN);
    },

    explosion(center, radius, color) {
      const e = explosions[explosionHead];
      explosionHead = (explosionHead + 1) % explosions.length;
      e.active = true;
      e.t = 0;
      e.radius = Math.max(0.5, radius);
      e.color.setHex(color);
      e.core.position.copy(center);
      e.shell.position.copy(center);
      const gy = floorAt(center.x, center.z, center.y);
      e.ring.position.set(center.x, gy + 0.03, center.z);
      e.core.visible = e.shell.visible = true;
      e.ring.visible = center.y - gy < radius * 1.2;
      const elum = Math.max(0.05, lumLinear(color));
      e.shellMat.uniforms.uColor.value.copy(e.color).multiplyScalar(Math.min(10, 2.2 / elum));
      e.light.color.copy(e.color).lerp(tColor.setRGB(1, 0.92, 0.8), 0.5);
      e.light.position.copy(center).addScaledVector(UP, 0.5);
      e.light.distance = e.radius * 5;
      e.light.intensity = 0;
      applyExplosion(e);

      spawnSparks(center, UP, color, 30, 9 * Math.sqrt(e.radius / 3), 1.0, 3.0, 0.55, 0.06);
      spawnDust(center, UP, 14, 3 * Math.sqrt(e.radius / 3), 1.1, 0.9 * Math.sqrt(e.radius / 3));
      spawnDebris(center, UP, 0x221f1c, 8, 7, 0.1);
      if (e.ring.visible) hazePuff(center.x, center.z, e.radius);
      camera.getWorldPosition(camPos);
      const dist = camPos.distanceTo(center);
      fx.shake(0.4 * THREE.MathUtils.clamp(1 - (dist - e.radius) / 18, 0, 1));
    },

    burst(point, color, count = 14) {
      // sparks (warm white) + flecks in the given colour (THREAT for enemies)
      spawnSparks(point, UP, 0xfff1d6, Math.ceil(count * 0.6), 5, 1.0, 3.0, 0.3, 0.04);
      spawnSparks(point, UP, color, Math.max(4, Math.round(count * 0.4)), 3.5, 1.0, 1.6, 0.45, 0.05, 1.4);
      spawnDebris(point, UP, 0x2d302a, Math.max(1, Math.round(count * 0.2)), 3.5, 0.06);
    },

    shake(amount) {
      trauma = Math.min(1, trauma + Math.max(0, amount));
    },

    flash(color, strength = 0.5) {
      if (!flashEl) return;
      if (!flashEl.isConnected) ctx.uiRoot.appendChild(flashEl); // HUD may have rebuilt uiRoot
      // Map the caller's hue onto the spec's two feedback colours: health red / shield BONE.
      tColor.setHex(color);
      const css = tColor.r > tColor.b ? '#E0402F' : '#ECEAE4';
      flashEl.style.color = css;
      flashAlpha = Math.min(0.25 + strength * 0.25, Math.max(flashAlpha, 0.15 + strength * 0.25));
      flashDecay = flashAlpha / 0.2; // gone in ~200 ms
      flashEl.style.opacity = flashAlpha.toFixed(3);
    },

    update(dt) {
      // keep point-size scale in sync with the drawing buffer / fov
      renderer.getDrawingBufferSize(drawSize);
      if (drawSize.y !== lastH || camera.fov !== lastFov) {
        lastH = drawSize.y;
        lastFov = camera.fov;
        sparks.setScale(lastH, lastFov);
        dust.setScale(lastH, lastFov);
      }

      camera.getWorldPosition(camPos);
      sparks.update(dt);
      dust.update(dt);
      debris.update(dt);

      for (let i = 0; i < tracers.length; i++) {
        const tr = tracers[i];
        if (!tr.active) continue;
        tr.t += dt;
        if (tr.t >= tr.life) {
          tr.active = false;
          tr.mesh.visible = false;
          continue;
        }
        applyTracer(tr);
      }

      for (let i = 0; i < decals.length; i++) {
        const d = decals[i];
        if (!d.active) continue;
        d.t += dt;
        if (d.t >= DECAL_LIFE) {
          d.active = false;
          d.mesh.visible = false;
          continue;
        }
        d.mat.opacity = Math.min(1, (DECAL_LIFE - d.t) / 3);
      }

      for (let i = 0; i < explosions.length; i++) {
        const e = explosions[i];
        if (!e.active) continue;
        e.t += dt;
        if (e.t >= EXPLOSION_LIFE) {
          e.active = false;
          e.core.visible = e.shell.visible = e.ring.visible = false;
          let shared = false;
          for (let j = 0; j < explosions.length; j++) {
            if (explosions[j] !== e && explosions[j].active && explosions[j].light === e.light) shared = true;
          }
          if (!shared) e.light.intensity = 0;
          continue;
        }
        applyExplosion(e);
      }

      if (flashEl && flashAlpha > 0) {
        flashAlpha = Math.max(0, flashAlpha - dt * flashDecay);
        flashEl.style.opacity = flashAlpha.toFixed(3);
      }

      // shake: undo our previous offset only if nobody re-set the camera since
      if (shakeApplied) {
        if (
          camera.position.equals(lastCamPos) &&
          camera.rotation.x === lastCamRot.x && camera.rotation.y === lastCamRot.y && camera.rotation.z === lastCamRot.z
        ) {
          camera.position.sub(shakePos);
          camera.rotation.x -= shakeRot.x;
          camera.rotation.y -= shakeRot.y;
          camera.rotation.z -= shakeRot.z;
        }
        shakeApplied = false;
      }
      if (trauma > 0) {
        trauma = Math.max(0, trauma - dt / 0.4);
        shakeTime += dt;
        const s = trauma * trauma;
        const t = shakeTime * 32;
        shakeRot.set(
          s * 0.045 * (Math.sin(t * 1.13) * 0.6 + Math.sin(t * 2.71 + 1.3) * 0.4),
          s * 0.045 * (Math.sin(t * 0.97 + 2.1) * 0.6 + Math.sin(t * 2.33 + 0.4) * 0.4),
          s * 0.06 * Math.sin(t * 1.61 + 4.2),
        );
        shakePos.set(
          s * 0.08 * Math.sin(t * 1.37 + 0.7),
          s * 0.08 * Math.sin(t * 1.79 + 2.9),
          0,
        );
        camera.position.add(shakePos);
        camera.rotation.x += shakeRot.x;
        camera.rotation.y += shakeRot.y;
        camera.rotation.z += shakeRot.z;
        lastCamPos.copy(camera.position);
        lastCamRot.set(camera.rotation.x, camera.rotation.y, camera.rotation.z);
        shakeApplied = true;
      }
    },
  };

  function applyTracer(tr: Tracer): void {
    const k = tr.t / tr.life;
    // tail chases the head; beam thins and fades
    tA.copy(tr.from).lerp(tr.to, Math.min(0.85, k * 0.9));
    const len = tA.distanceTo(tr.to);
    if (len < 1e-3) {
      tr.mesh.visible = false;
      return;
    }
    tr.mesh.position.copy(tA);
    tr.mesh.lookAt(tr.to);
    // keep at least ~1.4 px on screen at the segment's middle (sub-pixel lines shimmer and vanish)
    tB.copy(tA).lerp(tr.to, 0.5);
    const minW = camPos.distanceTo(tB) * TRACER_MIN_ANGLE;
    const w = Math.max(tr.width, minW) * (1 - 0.5 * k);
    tr.mesh.scale.set(w, w, len);
    tr.mat.opacity = 1 - k * k;
  }

  function applyExplosion(e: Explosion): void {
    const t = e.t;
    const r = e.radius;
    // 1) white flash sphere, lum 6, 0.08 s
    if (t < FLASH_LIFE) {
      const k = t / FLASH_LIFE;
      e.core.visible = true;
      e.core.scale.setScalar(r * (0.25 + 0.2 * k));
      // lum ≈ 6.5 at the centre, element-warmed a touch
      (e.coreMat.uniforms.uColor.value as THREE.Color).setRGB(6.5, 6.3, 6.0).lerp(tColor.copy(e.color).multiplyScalar(6.5), 0.15);
      e.coreMat.uniforms.uAlpha.value = 1 - k;
    } else {
      e.core.visible = false;
    }
    // 2) element-tinted fresnel shell expanding 0.25 s
    if (t < SHELL_LIFE) {
      const k = t / SHELL_LIFE;
      e.shell.visible = true;
      e.shell.scale.setScalar(r * (0.3 + 0.75 * (1 - Math.pow(1 - k, 3))));
      e.shellMat.uniforms.uAlpha.value = (1 - k) * (1 - k);
    } else {
      e.shell.visible = false;
    }
    // 3) grey dust ring rolling along the floor, 1.5 s
    const rk = t / EXPLOSION_LIFE;
    e.ring.scale.setScalar(r * (0.4 + 1.1 * (1 - Math.pow(1 - rk, 2.5))));
    e.ringMat.uniforms.uAlpha.value = 0.5 * (1 - rk) * Math.min(1, t / 0.08);
    e.ringMat.uniforms.uInner.value = 0.45 + 0.4 * rk;
    const lk = Math.max(0, 1 - t / 0.3);
    e.light.intensity = 30 * r * lk * lk;
  }

  return fx;
}
