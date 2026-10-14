/**
 * InkPass — renders the scene and draws thick black ink outlines.
 *
 * 1. Colour pass: scene → sceneRT (HalfFloat colour + float DepthTexture).
 * 2. Ink pass: scene with overrideMaterial = MeshNormalMaterial → normalRT (+ its own
 *    DepthTexture). Objects that should not be inked (Points/Lines/Sprites, transparent
 *    materials, glow materials flagged userData.noInk, sky) are hidden for this pass,
 *    and shadow maps are not re-rendered.
 * 3. Composite: edge = depth discontinuity (Laplacian of 1/z, relative) OR normal
 *    discontinuity, sampled at ±thickness px. Lines are suppressed where something
 *    un-inked (tracer, beam) sits in front, and faded with scene fog.
 */
import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const fragmentShader = /* glsl */ `
#include <packing>
uniform sampler2D tColor;
uniform sampler2D tDepthMain;
uniform sampler2D tNormal;
uniform sampler2D tDepthInk;
uniform vec2 texel;
uniform float thickness;
uniform float cameraNear;
uniform float cameraFar;
uniform vec3 inkColor;
uniform float inkStrength;
uniform float fogNear;
uniform float fogFar;
uniform float depthLo;
uniform float depthHi;
uniform float normalLo;
uniform float normalHi;
varying vec2 vUv;

float invZ( vec2 uv ) {
  float d = texture2D( tDepthInk, uv ).x;
  return -1.0 / perspectiveDepthToViewZ( d, cameraNear, cameraFar );
}
vec4 nrm( vec2 uv ) {
  vec4 t = texture2D( tNormal, uv );
  return vec4( t.xyz * 2.0 - 1.0, t.a );
}
float ndiff( vec4 c, vec4 o ) {
  // background neighbours are handled by the depth test
  return o.a < 0.5 ? 0.0 : 1.0 - dot( c.xyz, o.xyz );
}

void main() {
  vec4 base = texture2D( tColor, vUv );
  vec2 ox = vec2( texel.x * thickness, 0.0 );
  vec2 oy = vec2( 0.0, texel.y * thickness );

  float wc = invZ( vUv );
  float wl = invZ( vUv - ox );
  float wr = invZ( vUv + ox );
  float wd = invZ( vUv - oy );
  float wu = invZ( vUv + oy );
  // 1/z is affine in screen space on planes -> Laplacian is ~0 on flat surfaces.
  float lap = abs( wl + wr - 2.0 * wc ) + abs( wu + wd - 2.0 * wc );
  float wmax = max( wc, max( max( wl, wr ), max( wu, wd ) ) );
  float depthEdge = smoothstep( depthLo, depthHi, lap / max( wmax, 1e-6 ) );

  vec4 nc = nrm( vUv );
  float normalEdge = 0.0;
  if ( nc.a > 0.5 ) {
    float nd = max( max( ndiff( nc, nrm( vUv - ox ) ), ndiff( nc, nrm( vUv + ox ) ) ),
                    max( ndiff( nc, nrm( vUv - oy ) ), ndiff( nc, nrm( vUv + oy ) ) ) );
    normalEdge = smoothstep( normalLo, normalHi, nd );
  }
  float edge = max( depthEdge, normalEdge );

  // nearest inked surface distance (for fog fade + occlusion test)
  float distInk = 1.0 / max( wmax, 1e-6 );
  float dMain = texture2D( tDepthMain, vUv ).x;
  float distMain = -perspectiveDepthToViewZ( dMain, cameraNear, cameraFar );
  // something without ink (glow, beam, tracer) is in front of the inked surface
  float occluded = step( distMain + 0.05 + distMain * 0.01, 1.0 / max( wc, 1e-6 ) );
  edge *= 1.0 - occluded;

  float fogF = smoothstep( fogNear, fogFar, distInk );
  edge *= inkStrength * ( 1.0 - 0.9 * fogF );

  gl_FragColor = vec4( mix( base.rgb, inkColor, clamp( edge, 0.0, 1.0 ) ), 1.0 );
}
`;

export class InkPass extends Pass {
  readonly sceneRT: THREE.WebGLRenderTarget;
  readonly normalRT: THREE.WebGLRenderTarget;
  readonly material: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  private normalMaterial = new THREE.MeshNormalMaterial();
  private hidden: THREE.Object3D[] = [];
  private clearColor = new THREE.Color();
  private readonly hideVisitor: (o: THREE.Object3D) => void;

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    width: number,
    height: number,
  ) {
    super();
    this.needsSwap = true;
    this.sceneRT = makeTarget(width, height);
    this.normalRT = makeTarget(width, height);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: this.sceneRT.texture },
        tDepthMain: { value: this.sceneRT.depthTexture },
        tNormal: { value: this.normalRT.texture },
        tDepthInk: { value: this.normalRT.depthTexture },
        texel: { value: new THREE.Vector2(1 / width, 1 / height) },
        thickness: { value: 1 },
        cameraNear: { value: camera.near },
        cameraFar: { value: camera.far },
        inkColor: { value: new THREE.Color(0x04050c) },
        inkStrength: { value: 1 },
        fogNear: { value: 40 },
        fogFar: { value: 160 },
        depthLo: { value: 0.06 },
        depthHi: { value: 0.14 },
        normalLo: { value: 0.22 },
        normalHi: { value: 0.38 },
      },
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.material);
    this.hideVisitor = (o: THREE.Object3D) => {
      if (!o.visible) return;
      if (shouldSkipInk(o)) {
        o.visible = false;
        this.hidden.push(o);
      }
    };
  }

  /** Line thickness in device pixels (≈ half-width; full line ≈ 2× this). */
  setThickness(px: number): void {
    this.material.uniforms.thickness.value = px;
  }

  setFog(near: number, far: number): void {
    this.material.uniforms.fogNear.value = near;
    this.material.uniforms.fogFar.value = far;
  }

  override setSize(width: number, height: number): void {
    this.sceneRT.setSize(width, height);
    this.normalRT.setSize(width, height);
    (this.material.uniforms.texel.value as THREE.Vector2).set(1 / width, 1 / height);
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget): void {
    const { scene, camera } = this;
    const u = this.material.uniforms;
    u.cameraNear.value = camera.near;
    u.cameraFar.value = camera.far;

    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    // 1. colour
    renderer.setRenderTarget(this.sceneRT);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);

    // 2. normals + depth of inked geometry only
    const prevBg = scene.background;
    const prevOverride = scene.overrideMaterial;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    renderer.getClearColor(this.clearColor);
    const prevAlpha = renderer.getClearAlpha();

    this.hidden.length = 0;
    scene.traverse(this.hideVisitor);
    scene.background = null;
    scene.overrideMaterial = this.normalMaterial;
    renderer.shadowMap.autoUpdate = false;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.normalRT);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);

    renderer.setClearColor(this.clearColor, prevAlpha);
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;
    for (let i = 0; i < this.hidden.length; i++) this.hidden[i].visible = true;
    this.hidden.length = 0;

    // 3. composite
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.quad.render(renderer);
    renderer.autoClear = prevAutoClear;
  }

  override dispose(): void {
    this.sceneRT.dispose();
    this.normalRT.dispose();
    this.material.dispose();
    this.normalMaterial.dispose();
    this.quad.dispose();
  }
}

function makeTarget(w: number, h: number): THREE.WebGLRenderTarget {
  const depth = new THREE.DepthTexture(w, h, THREE.FloatType);
  depth.minFilter = THREE.NearestFilter;
  depth.magFilter = THREE.NearestFilter;
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    depthTexture: depth,
  });
  rt.texture.generateMipmaps = false;
  return rt;
}

function shouldSkipInk(o: THREE.Object3D): boolean {
  if (o.userData.noInk) return true;
  const anyO = o as any;
  if (anyO.isPoints || anyO.isLine || anyO.isSprite) return true;
  if (anyO.isMesh) {
    const mat = (o as THREE.Mesh).material;
    const m = Array.isArray(mat) ? mat[0] : mat;
    if (!m) return false;
    if (m.transparent || m.userData.noInk || !m.depthWrite) return true;
  }
  return false;
}
