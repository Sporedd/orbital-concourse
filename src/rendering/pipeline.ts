/**
 * Scene lighting, sky, haze and the post-processing chain (docs/ART_DIRECTION.md §4, §5):
 *   RenderPass → UnrealBloom (0.7 / 0.6 / threshold 1.0) → Grade (chroma-protected
 *   saturation, contrast, lift, shoulder, vignette, grain, dither, hit-only CA, linear→sRGB)
 *   → FXAA (to screen).
 * The ink outline pass (inkPass.ts) is no longer used. Floodlight spots, shafts and pools
 * belong to the world (they follow the league); fog density too.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { ARENA } from '@/core/config';
import { createRng } from '@/core/rng';
import type { GameContext } from '@/core/types';
import { createHaze } from './haze';
import { createPresence } from './presence';
import { surfaceUniforms } from './materials';
import { createSky } from './sky';
import { shaftShared } from './shafts';
import { LEAGUE_STYLE, LIGHT, PALETTE, STYLE, type LeagueStyle } from './style';

export interface RenderPipeline {
  render(): void;
  resize(width: number, height: number): void;
  update(dt: number): void;
}

/** Fallback fog (the world sets the league density). */
export const FOG_COLOR = PALETTE.HAZE;
export const FOG_DENSITY = LEAGUE_STYLE.scrap.fogDensity;

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: 0.35 },
    uShadowTint: { value: new THREE.Vector3(0.97, 0.99, 1.03) },
    uHighTint: { value: new THREE.Vector3(1.03, 1.0, 0.95) },
    uExposure: { value: LIGHT.exposure },
    uTime: { value: 0 },
    uGrain: { value: 0.035 },
    uCA: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform vec3 uShadowTint;
    uniform vec3 uHighTint;
    uniform float uExposure;
    uniform float uTime;
    uniform float uGrain;
    uniform float uCA;
    varying vec2 vUv;
    vec3 toSRGB( vec3 c ) {
      c = max( c, vec3( 0.0 ) );
      return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( 0.0031308, c ) );
    }
    float shoulder1( float x ) {
      const float s = 0.78;
      return x <= s ? x : s + ( 1.0 - s ) * ( 1.0 - exp( -( x - s ) / ( 1.0 - s ) ) );
    }
    // Hue-preserving shoulder: compress the brightest channel and scale rgb with it, so a
    // saturated emissive (THREAT red at x6.5) stays red instead of clipping to pink/white.
    // Whiteness then comes from luminance only: muzzle/explosion flashes (lum 6+) and loot cores
    // go white-hot, threat (1.5-2.5) and accents (~1.1) keep their hue.
    vec3 shoulder( vec3 c, float lumIn ) {
      float m = max( max( c.r, c.g ), max( c.b, 1e-5 ) );
      vec3 o = c * ( shoulder1( m ) / m );
      float w = smoothstep( 2.2, 9.0, lumIn ) * 0.8;
      return mix( o, vec3( max( max( o.r, o.g ), o.b ) ), w );
    }
    float ign( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
    float h12( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
    void main() {
      vec3 c;
      if ( uCA > 0.0 ) {
        vec2 d = ( vUv - 0.5 ) * uCA;
        c = vec3( texture2D( tDiffuse, vUv + d ).r, texture2D( tDiffuse, vUv ).g, texture2D( tDiffuse, vUv - d ).b );
      } else {
        c = texture2D( tDiffuse, vUv ).rgb;
      }
      c *= uExposure;
      const vec3 W = vec3( 0.2126, 0.7152, 0.0722 );
      float lum = dot( c, W );
      c *= mix( uShadowTint, uHighTint, smoothstep( 0.04, 0.65, lum ) );
      // chroma-protected saturation: dim world desaturated, bright emissives keep/gain chroma
      float l2 = dot( c, W );
      float sat = mix( 0.80, 1.15, smoothstep( 0.6, 1.4, l2 ) );
      c = max( mix( vec3( l2 ), c, sat ), 0.0 );
      // contrast around 0.18 (linear)
      c = 0.18 * pow( c / 0.18, vec3( 1.12 ) );
      c += vec3( 0.006, 0.006, 0.007 );
      c = shoulder( c, l2 );
      vec2 q = vUv - 0.5;
      float vig = smoothstep( 0.25, 0.85, length( q * vec2( 1.0, 0.85 ) ) * 1.25 );
      c *= 1.0 - uVignette * vig;
      vec3 s = toSRGB( c );
      // film grain: luminance-only, animated, weighted to midtones
      float sl = dot( s, W );
      float g = ( h12( gl_FragCoord.xy + fract( uTime * 13.7 ) * 811.0 ) - 0.5 ) * 2.0;
      s += g * uGrain * ( 1.0 - min( 1.0, abs( sl - 0.5 ) * 1.2 ) );
      // dither ±0.5/255
      s += ( ign( gl_FragCoord.xy + fract( uTime ) * 64.0 ) - 0.5 ) / 255.0;
      gl_FragColor = vec4( s, 1.0 );
    }
  `,
};

/**
 * three's FXAA compiles with D3D (ANGLE) warnings: X3595 (implicit-derivative texture
 * fetch inside the edge-walk loop) and X4000 (early return in ApplyFXAA). Sample with an
 * explicit LOD and give ApplyFXAA a single exit. Falls back to the stock shader if the
 * source ever changes shape.
 */
function patchFxaa(src: typeof FXAAShader): typeof FXAAShader {
  let fs = src.fragmentShader.replace(/return\s+texture\(\s*tex2D,\s*uv\s*\);/, 'return textureLod( tex2D, uv, 0.0 );');
  const start = fs.indexOf('vec4 ApplyFXAA(');
  const end = fs.indexOf('void main()');
  if (fs === src.fragmentShader || start < 0 || end < start) return src;
  fs = fs.slice(0, start) + /* glsl */ `vec4 ApplyFXAA( sampler2D tex2D, vec2 texSize, vec2 uv ) {
  vec2 suv = uv;
  LuminanceData luminance = SampleLuminanceNeighborhood( tex2D, texSize, uv );
  if ( !ShouldSkipPixel( luminance ) ) {
    float pixelBlend = DeterminePixelBlendFactor( luminance );
    EdgeData edge = DetermineEdge( texSize, luminance );
    float edgeBlend = DetermineEdgeBlendFactor( tex2D, texSize, luminance, edge, uv );
    float finalBlend = max( pixelBlend, edgeBlend );
    if ( edge.isHorizontal ) suv.y += edge.pixelStep * finalBlend;
    else suv.x += edge.pixelStep * finalBlend;
  }
  return Sample( tex2D, suv );
}

` + fs.slice(end);
  return { ...src, fragmentShader: fs };
}

/** Key light azimuth: from the main (north-west) floodlight bank. */
export const KEY_DIR = new THREE.Vector3(-0.62, Math.tan(THREE.MathUtils.degToRad(58)) * Math.hypot(0.62, 0.78) / 1, -0.78).normalize();

export function setupRenderingImpl(ctx: GameContext): RenderPipeline {
  const { scene, camera, renderer } = ctx;
  const rand = createRng(0x5a0b0);

  // ---- fog + background fallback ------------------------------------------
  if (!(scene.fog instanceof THREE.FogExp2)) scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);
  scene.background = new THREE.Color(0x07080a);

  // camera children (viewmodel) only render when the camera is in the scene graph
  if (!camera.parent) scene.add(camera);

  // ---- lights --------------------------------------------------------------
  const keyColor = new THREE.Color(PALETTE.FLOODLIGHT);
  const keyIntensity = LIGHT.key;
  const key = new THREE.DirectionalLight(keyColor, keyIntensity);
  key.name = 'keyLight';
  key.position.copy(KEY_DIR).multiplyScalar(80);
  key.target.position.set(0, 0, 0);
  key.castShadow = true;
  const sc = key.shadow.camera;
  const ext = ARENA.halfSize + 6;
  sc.left = -ext;
  sc.right = ext;
  sc.top = ext;
  sc.bottom = -ext;
  sc.near = 5;
  sc.far = 200;
  sc.updateProjectionMatrix();
  key.shadow.mapSize.set(STYLE.q.shadowMapSize, STYLE.q.shadowMapSize);
  key.shadow.radius = 3;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  scene.add(key, key.target);

  // fill: physical units chosen for the spec's intent (see LIGHT in style.ts)
  const hemi = new THREE.HemisphereLight(LIGHT.hemiSky, LIGHT.hemiGround, LIGHT.hemi);
  hemi.name = 'hemiLight';
  scene.add(hemi);
  const ambient = new THREE.AmbientLight(LIGHT.ambientColor, LIGHT.ambient);
  ambient.name = 'ambientLight';
  scene.add(ambient);

  const syncKeyRef = () => {
    const c = key.color;
    surfaceUniforms.uKeyRef.value = (key.intensity / Math.PI) * (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
  };
  syncKeyRef();
  shaftShared.uGain.value = LIGHT.shaftGain;
  shaftShared.motes = STYLE.q.shaftMotes;

  // ---- sky + haze -----------------------------------------------------------
  const sky = createSky(rand);
  scene.add(sky.group);
  const haze = createHaze();
  scene.add(haze.group);
  const presence = createPresence(ctx);

  let shownLeague: LeagueStyle | null = null;
  const applyLeague = (ls: LeagueStyle) => {
    shownLeague = ls;
    sky.setPlanet(ls.planet);
    keyColor.set(ls.floodColor);
    key.color.copy(keyColor);
    surfaceUniforms.uRimColor.value.set(ls.floodColor);
    syncKeyRef();
    surfaceUniforms.uGroundHaze.value.w = ls.id === 'scrap' ? 0.28 : ls.id === 'void' ? 0.12 : ls.id === 'iron' ? 0.24 : 0.2;
    // spec strength (§5.1); the band is depth-stacked (haze.ts) so it no longer flattens the stands
    haze.setStrength(LIGHT.groundHaze * (ls.id === 'void' ? 0.7 : 1), LIGHT.standHaze * (ls.id === 'void' ? 0.7 : 1));
  };
  const worldLeague = (): LeagueStyle => (ctx.world as unknown as { leagueStyle?: LeagueStyle })?.leagueStyle ?? LEAGUE_STYLE.scrap;
  applyLeague(worldLeague());

  // ---- post -------------------------------------------------------------------
  const size = new THREE.Vector2();
  renderer.getSize(size);
  let pr = renderer.getPixelRatio();

  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(pr);
  composer.setSize(size.x, size.y);

  composer.addPass(new RenderPass(scene, camera));

  const bloomScale = STYLE.q.bloomScale;
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x * bloomScale, size.y * bloomScale), 0.7, 0.6, 1.0);
  composer.addPass(bloom);

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  const fxaa = new ShaderPass(patchFxaa(FXAAShader));
  composer.addPass(fxaa);

  const applySize = (w: number, h: number) => {
    pr = renderer.getPixelRatio();
    composer.setPixelRatio(pr);
    composer.setSize(w, h);
    if (bloomScale !== 1) bloom.setSize(Math.max(1, Math.floor(w * pr * bloomScale)), Math.max(1, Math.floor(h * pr * bloomScale)));
    const dw = Math.max(1, Math.floor(w * pr));
    const dh = Math.max(1, Math.floor(h * pr));
    (fxaa.material.uniforms.resolution.value as THREE.Vector2).set(1 / dw, 1 / dh);
    sky.setPixelRatio(pr);
  };
  applySize(size.x, size.y);

  // chromatic aberration: feedback only, 150 ms on a local player hit
  let caT = 0;
  ctx.events.on('player:damaged', (e) => {
    if (ctx.player && e.playerId === ctx.player.id) caT = 0.15;
  });

  const camPos = new THREE.Vector3();

  const pipeline: RenderPipeline = {
    render() {
      composer.render(ctx.time.delta);
    },
    resize(width, height) {
      applySize(width, height);
    },
    update(dt) {
      camera.getWorldPosition(camPos);
      const ls = worldLeague();
      if (ls !== shownLeague) applyLeague(ls);
      sky.update(dt, ctx.time.elapsed, camPos, camera);
      haze.update(dt);
      presence.update(dt, ctx.time.elapsed);
      grade.uniforms.uTime.value = ctx.time.elapsed % 1000;
      caT = Math.max(0, caT - dt);
      grade.uniforms.uCA.value = caT > 0 ? 0.004 * (caT / 0.15) : 0;
    },
  };

  // look-dev handle (like window.game in main.ts): live light/haze/post tuning, a synchronous
  // render and update (rAF stops while the browser pane is hidden)
  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__rendering = {
      key, hemi, ambient, haze, bloom, grade, sky, composer, shaftShared, surfaceUniforms, syncKeyRef,
      render: () => composer.render(0),
      update: (dt: number) => pipeline.update(dt),
    };
  }
  return pipeline;
}
