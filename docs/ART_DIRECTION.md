# Orbital Concourse — Art Direction: C · BRUTALIST ARENA

Implementation spec for the chosen look. It is written so an engineer can build it without seeing the boards.
Boards (overview, C, C HUD/UI, leagues, and alternatives A and B): https://claude.ai/artifact/UaxZF3PpDDHhko759k5eQR
Mood target: `docs/concepts/C-brutalist.png`. Take from it the concrete, floodlight shafts in haze, orange accent strips, silhouetted crowd and hazard floor paint. Leave out the photoreal detail and texture work, and ignore its gibberish scoreboard glyphs.

> **Grimdark revision (2026-10-15):** the arena's lighting, atmosphere and dressing now follow `docs/concepts/D-grimdark-arena.png`. **§15 overrides §1.1, §5, §6, §7 and §12 wherever they disagree.** The enemy and boss armour design (§8) stays as it is: only its brightness changed.

> **One sentence:** a concrete colosseum on an orbital station. The world is matte and near-grey, and the only saturated things on screen are light, loot, threat and one accent colour per league.

---

## 0. Pillars (the rules everything else follows)

1. **Lit, not drawn.** No outlines, no hatching, no comic type. Form comes from value, haze and light.
2. **Saturation budget.** Environment chroma stays ≤ 12 %. Saturation belongs to four channels only:
   **rarity** (loot), **threat** (enemies, telegraphs), **league accent** (architecture strips and signage) and **element** (shots, status).
3. **Brightness hierarchy (HDR luminance, linear):** environment ≤ 0.8 < accent strips ≈ 1.0–1.2 < threat 1.5–2.5 < loot 2.5–6 < muzzle and explosion flash 6+. Bloom threshold is 1.0, so the hierarchy also decides what glows.
4. **Heavy, rectilinear shapes.** Slabs, ribs, 45° chamfers, monoliths. No organic curls or horns.
5. **The crowd is the show.** Silhouettes in haze that react: camera flashes, accent chases, floodlight swings.

---

## 1. Palette

All hex values are sRGB. Three.js converts `Color` to linear (ColorManagement on). "Lum" means linear luminance `dot(rgb_lin, (0.2126, 0.7152, 0.0722))`.

### 1.1 World

| Token | Hex | Role |
|---|---|---|
| `SHADOW` | `#1C1E21` | ambient/shadow reference, under-stands, dark panels |
| `CONCRETE_DARK` | `#4A4A48` | stand walls, under-structure, crowd tier base |
| `CONCRETE` | `#6F6D68` | **base albedo** for walls, props, floor |
| `CONCRETE_LIT` | `#9A978F` | light-coloured precast pieces: wall coping, plinth, barrier tops |
| `STEEL` | `#4E555C` | trusses, doors, containers, railings (cool) |
| `STEEL_DARK` | `#2A2C2F` | lattice towers, roof underside, gun polymer |
| `HAZE` | `#3A3D42` | fog colour (distance) |
| `HAZE_LIT` | `#A9ABAD` | lit haze: ground haze, stand haze band |
| `FLOODLIGHT` | `#F3EEDF` | key light, spotlights, shafts, lamp heads (Void: `#E6E2FF`) |
| `HAZARD_PAINT` | `#C9A227` | **non-emissive** painted floor rings, chevrons, warning triangles, all leagues |
| `THREAT` | `#FF2238` | enemy visors, cores, weak points, gate spawn lamps, laser grids. **Hostile only.** |
| `BONE` | `#ECEAE4` | UI text and rules, stencil plates on the world |

### 1.2 League accent (the one saturated architecture colour)

| League | Accent | Glow intensity for lum ≈ 1.1 |
|---|---|---|
| Scrap | `#FF5F1F` rust signal | 3.7 |
| Iron | `#FFC61A` hazard yellow | 1.8 |
| Steel | `#1FD1C1` arc teal | 2.2 |
| Star | `#E8368F` prestige magenta | 4.0 (clamped) |
| Void | `#8C6CFF` ultraviolet | 4.0 (clamped) |

Compute glow intensity from a luminance target, not from a fixed multiplier:
`glowIntensity(color, targetLum) = min(4, targetLum / lum(color))`. Accent strips use targetLum **1.1**.

### 1.3 Rarity and element (unchanged)

Keep `RARITY_COLORS` and `ELEMENT_COLORS` in `src/core/types.ts` as they are. The grey world gives them headroom, so their hues need no change. Two known hue collisions are solved by **shape, brightness and motion**, not by changing hue:
- legendary `#FF9A1F` against Scrap accent `#FF5F1F`
- fire element `#FF5A1F` against Scrap accent

Accent is always static, straight, architectural and lum ≤ 1.2. Loot is a vertical column with a white core, lum ≥ 2.5, and it moves. Fire is a moving tracer or flame.

### 1.4 Enemy and character

| Token | Hex | Role |
|---|---|---|
| `ARMOUR` | `#4E5249` | olive-grey plate (base) |
| `ARMOUR_LIT` | `#6E7366` | top plates, pauldrons |
| `UNDERSUIT` | `#2D302A` | joints, under-layer |
| `THREAT` | `#FF2238` | visor slit, chest core, weak points |

---

## 2. Materials (`src/rendering/materials.ts`)

Keep `toon()` returning a `MeshToonMaterial` (systems tint `.color` and `.emissive`). Replace the 3-band ramp and hatching with the rules below.

### 2.1 Light ramp: 2 bands, soft terminator

MeshToon samples the gradient map at `u = dot(N, L) * 0.5 + 0.5`.
- 64-texel `DataTexture`, **LinearFilter** (not Nearest), no mipmaps.
- Values: `u < 0.47` → **0.16** (41/255). `0.47 ≤ u ≤ 0.55` → smoothstep to **1.0** (255). Above that, 1.0.
  This puts the terminator at NdotL ≈ −0.06…+0.10: two flat bands joined by a narrow soft edge. **No mid band.**
- Shadow maps: `PCFSoftShadowMap`, `shadow.radius = 3`, so cast-shadow edges match the soft terminator.
- Normals: **flat-shaded** for all architecture and props (non-indexed geometry plus `computeVertexNormals`, or `flatShading: true`). Characters, the viewmodel and gear stay smooth.

### 2.2 Surface kinds

Extend `ToonOptions` with optional, non-breaking fields. `hatch` stays accepted but is ignored.
```ts
surface?: 'concrete' | 'steel' | 'paint' | 'character' | 'flat'; // default 'concrete'
mottle?: number;  // override, 0..0.15
sheen?: number;   // override, 0..0.3
rim?: number;     // override, 0..0.5
```
Defaults per kind:

| kind | mottle | grime | sheen | rim | notes |
|---|---|---|---|---|---|
| concrete | 0.06 | 0.25 | 0 | 0 | walls, floor (grime 0 on floor), stands, props |
| steel | 0.03 | 0.15 | 0.12 | 0 | doors, trusses, containers, railings |
| paint | 0.08 | 0 | 0 | 0 | hazard paint, stencil plates (worn look from mottle) |
| character | 0.02 | 0 | 0.08 | 0.35 | enemies, bosses, gear, viewmodel |
| flat | 0 | 0 | 0 | 0 | crowd base geometry, under-structure |

Pass the per-material values as one `vec4 uSurf = (mottle, grime, sheen, rim)` uniform. Each material gets its own uniform object inside `onBeforeCompile`. All of them share one `customProgramCacheKey` (`'concourse-c-surface-v1'`), so there is one program.

### 2.3 Shader injection (onBeforeCompile)

**Vertex.** Add `varying vec3 vSbWorld;` and compute the world position yourself, because `worldpos_vertex` is conditional:
```glsl
vec4 sbW = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  sbW = instanceMatrix * sbW;
#endif
vSbWorld = ( modelMatrix * sbW ).xyz;
```
Static batched geometry is already in world space (modelMatrix = identity), so this works there too.

**Fragment, before lighting** (after `#include <color_fragment>`):
- **Mottle**, which replaces hatching: `n = (vnoise3(vSbWorld*1.6) - 0.5) + (vnoise3(vSbWorld*0.25) - 0.5);` then `diffuseColor.rgb *= 1.0 + n * uSurf.x;`. That is two octaves, ≈0.6 m and ≈4 m. Use the same hash/value noise as `sky.ts`, made 3D.
- **Contact grime**: `diffuseColor.rgb *= mix(1.0 - uSurf.y, 1.0, smoothstep(0.0, 1.2, vSbWorld.y));`.

**Fragment, after lighting** (before `#include <opaque_fragment>`):
- `litMask = clamp(lum(reflectedLight.directDiffuse) / (max(lum(diffuseColor.rgb), 0.03) * uKeyRef), 0., 1.)`. `uKeyRef = keyIntensity/π · lum(keyColor)`, the same idea as the old `uHatchRef`.
- **Sheen**, broad and dull: `H = normalize(directionalLights[0].direction + geometryViewDir)`, then `outgoingLight += directionalLights[0].color * uSurf.z * pow(max(dot(normal, H), 0.), 12.) * litMask;`. Guard it with `#if NUM_DIR_LIGHTS > 0`.
- **Character back-rim**: `fres = 1. - saturate(dot(normal, geometryViewDir)); outgoingLight += uRimColor * uSurf.w * smoothstep(0.62, 0.92, fres);`. `uRimColor` = FLOODLIGHT (shared uniform). The rim must stay below lum 1.0, so it never blooms.
- **No** screen-space patterns of any kind on surfaces.

### 2.4 Glow (`glow()`)

Keep the unlit MeshBasic glow, but add a luminance-target helper: `glowLum(color, targetLum)`. Emissive tiers:

| Use | target lum |
|---|---|
| scoreboard / LED boards | 0.9 |
| league accent strips, LED ribbons | 1.1 |
| enemy visor / core | 1.5 |
| weak point (pulsing 1.5↔2.5) | 2.5 |
| floodlight lamp discs | 3.0 |
| loot beam core | 2.5–6 by rarity (§9) |
| muzzle flash, explosion flash | 6–8 |

Accent strips keep `fog: true`. Loot beams and lamp discs use `fog: false`, so they cut through the haze.

---

## 3. Edges

- **The outline pass is off.** In `pipeline.ts`, replace `InkPass` with a plain `RenderPass(scene, camera)`. Leave `inkPass.ts` in the repo, unused (or behind `STYLE.ink = false`). This also removes the per-frame normal-buffer scene render.
- Edge definition comes from:
  1. **Value contrast.** Light precast pieces (`CONCRETE_LIT`) sit against dark (`CONCRETE_DARK`) recesses.
  2. **Real chamfers.** Add a `chamferBox(w, h, d, c)` geometry helper: a box with 45° chamfers on the top edges and the vertical edges, about 44 triangles. Use c = 0.08–0.12 m on every slab bigger than 1 m. With flat normals, the chamfer catches the key as a thin lit strip, so the light draws the edge.
  3. **Haze depth.** Far planes fade toward `HAZE`.
  4. **Back-rim** on characters only (§2.3).
- Never draw dark lines on silhouettes, in UI or in-world.

---

## 4. Post chain (`pipeline.ts`)

`RenderPass → UnrealBloomPass → GradePass (updated) → FXAA`. The composer targets stay HalfFloat (HDR).

**Bloom:** `UnrealBloomPass(res, strength 0.7, radius 0.6, threshold 1.0)`. Only lum > 1 glows, so the environment never blooms and the hierarchy in §0.3 decides the rest.

**Grade** (extend `GradeShader`, same structure):

| Param | Value | Notes |
|---|---|---|
| exposure | 1.0 | |
| shadow tint | (0.97, 0.99, 1.03) | faint cool in darks |
| high tint | (1.03, 1.00, 0.95) | faint sodium warmth in lights |
| **chroma-protected saturation** | `sat = mix(0.80, 1.15, smoothstep(0.6, 1.4, lum))` | dim world is desaturated; bright emissives keep or gain chroma |
| contrast | `c = 0.18 * pow(c / 0.18, 1.12)` | pivot 0.18 (linear), before shoulder |
| lift | + (0.006, 0.006, 0.007) | keeps blacks off pure black |
| shoulder | 0.78 (keep) | |
| vignette | 0.35, `smoothstep(0.25, 0.85, r)` | |
| **film grain** | 0.035 amplitude, sRGB space, animated (`uTime`), luminance-only, weighted to midtones `g * (1 - abs(lum - 0.5) * 1.2)` | |
| **dither** | interleaved-gradient noise ±0.5/255 after sRGB | kills fog and haze banding |
| chromatic aberration | **0** by default; 0.004 radial for 150 ms on player hit | feedback only, never a style layer |

---

## 5. Lighting rig: the colosseum

| Light | Setup |
|---|---|
| **Key** | `DirectionalLight` FLOODLIGHT `#F3EEDF`, intensity **3.2**, elevation 58°, azimuth toward the main floodlight bank. `castShadow`, 2048², PCFSoft, radius 3, bias −0.0004, normalBias 0.03, shadow box = arena ±(halfSize+6). It stands in for the combined floodlight banks. |
| **Fill** | `HemisphereLight` sky `#3A3E45`, ground `#6F6D68` (floor bounce), intensity **1.1**. Plus `AmbientLight` `#1C1E21` at 0.3. |
| **Floodlight spots** | One `SpotLight` per tower. Colour FLOODLIGHT, angle 0.38 rad, penumbra 0.6, decay 2, distance 90, **no shadows**. Tune intensity (≈800 cd) for a floor irradiance of ≈0.6 at the pool centre. Aim at points on the play floor, ring-offset. Count per league: §12. Low-quality preset: max 4 real spots, the rest pools only. |
| **Light pools** | Per tower, an additive floor decal (`PlaneGeometry`, radial-falloff shader, lum 0.15, `depthWrite false`, polygonOffset). Lit zones still read where the spot is culled. |
| **Gate lamps** | 4 pooled `PointLight`s, THREAT, used only while a gate telegraphs a spawn (0.8 s pulse). Accent strips **do not** light the scene. |
| **Muzzle flash** | 1 pooled `PointLight` near the muzzle, 0.05 s. It sells the grey world, so keep it. |
| Remove | moon light, lantern PointLights, all warm/cold BL contrast lights. |

### 5.1 Haze (cheap, never off)

1. **Fog:** `FogExp2(HAZE #3A3D42, density)`. Density per league: Scrap 0.016, Iron 0.013, Steel 0.011, Star 0.009, Void 0.006.
2. **Light shafts** (new `src/rendering/shafts.ts`): per floodlight, an open `ConeGeometry(radius ≈ 7 m at the floor, height = lamp→floor distance, 24 segments, openEnded)`, apex at the lamp. Custom `ShaderMaterial`: `AdditiveBlending`, `depthWrite false`, `DoubleSide`, `fog false`, `userData.noInk`.
   - `v` = 0 at the lamp, 1 at the floor. Alpha = `uI * pow(1 - v, 1.5) * pow(abs(dot(N, V)), 1.5) * (1 - smoothstep(0.85, 1.0, v)) * smoothstep(0.5, 3.0, -viewPos.z)`.
     This gives a length fade, soft cone edges, no hard floor intersection and a near-camera fade.
   - Colour FLOODLIGHT × `uI`. `uI` = 0.12 (Scrap 0.16 dusty, Void 0.10).
   - **Dust motes:** 30 `Points` per shaft, spawned inside the cone volume, drifting 0.1 m/s, 2–3 px, additive, lum 0.6.
3. **Ground haze:** 2 horizontal quads over the floor at y 0.3 and 0.9 m. fbm-noise alpha scrolling at 0.02 m/s, colour HAZE_LIT, alpha 0.08, normal blending, `depthWrite false`.
4. **Stand haze band:** an open cylinder at r = 32.5 m, height 0–18 m, facing inward. Alpha 0.18 at the bottom fading to 0 at the top, colour HAZE_LIT. It separates the stands from the pit and is the main source of depth.
5. **Remove** `snow.ts`. Dust motes and the ground haze replace it.

---

## 6. Sky and station (`sky.ts`)

- The **roof ring** frames the sky: an annulus, inner r = 30 m, outer r = 60 m, at y = 26 m, 2 m thick, `STEEL_DARK` underside with radial ribs every 15°. The inner edge is a chamfered `CONCRETE_LIT` lip, so its lit edge draws the oculus. 4 radial trusses span the oculus. The scoreboard hangs from them.
- **Dome shader:** zenith `#07080A`, horizon `#15181C`. **No aurora.**
- **Stars:** keep the star Points, white only, brightness × 0.6, slow twinkle, no colour.
- **Planet:** a dome-shader disc or far sphere seen through the oculus at elevation 50–70°. Pale and desaturated: `#D6DCDF` → `#8F9AA1` → `#3A4147`, fbm cloud bands, terminator smoothstep 0.08 wide, thin atmosphere rim `#C9D3D8` at 0.5 alpha. Size and visibility per league (§12). Void: a black disc with a white corona (`#F2F0FF`, lum 2, blooms). This is the only league with an in-sky back light.
- **Station:** one distant spoke (a long box rail with 10–20 lit window dots, lum 0.8) crossing part of the oculus view. That is enough to say "orbital".

---

## 7. Arena layout (`src/world/props.ts`, `src/world/index.ts`)

Remove: snow floor, ice wall and cliffs, huts, pines, lanterns, aurora glow bits. Play space stays inside `ARENA.halfSize = 32`.

| Element | Spec |
|---|---|
| **Play floor** | Circle r = 30 m, CONCRETE (`surface: concrete`, grime 0). 4 m slab seams in the floor shader: `fract(xz / 4)` lines 2 cm wide, × 0.8 value. Two dark expansion joints cross the centre. |
| **Floor paint** | HAZARD_PAINT (`surface: paint`): solid ring r 27 m × 0.25 m, striped ring r 28 m × 0.4 m (45° stripes, 0.4 m pitch, PAINT/`#1C1E21`), centre circle r 4 m around the plinth, warning triangles 1.2 m in front of each gate. Paint is geometry (thin decal strips, y = 0.005), never emissive. |
| **Arena wall** | r = 30.5–32 m, 4 m tall. Collision as a 24-gon of AABBs, or keep the current square-wall collision with visual round panels. Precast panels 6 m wide with 0.1 m recessed seams, a chamfered CONCRETE_LIT coping. LED ribbon along the coping from Iron upward (accent, lum 1.1). |
| **Pillars** | Every 15° at r = 33 m, 1.6 × 1.6 m, from floor to roof (26 m). One vertical accent strip on the arena-facing side, 0.12 m wide, from 6 m to 20 m. |
| **Stands** | 3 tiers from r 33 → 48 m, rising 5 → 20 m. Tier faces CONCRETE_DARK, risers CONCRETE. Non-collidable. Steel railing (thin STEEL boxes) on each tier lip. |
| **Crowd** | New `src/world/crowd.ts`: **instanced quads**, 2 tris each, camera-facing around the Y axis. The fragment shader draws a head-and-shoulders SDF with alpha-test 0.5. Unlit `MeshBasic`-style colour per instance from `#1F2124`–`#3A3C40` (darker at front tiers), `fog: true`, so they read as silhouettes against the stand haze. Count per league: §12. Vertex animation from uniforms: idle bob 0.02 m; `uHype` 0..1 → cheer jump up to 0.15 m at 3 Hz; `uWave` = a wave moving around the ring angle on multi-kills. **Camera flashes:** on kill events, 0.3 % of instances (3 % on boss kill or legendary drop) render a 1–2 frame white square at lum 4 (blooms). Void only: a per-instance accent wristband dot (lum 1.2). |
| **Floodlight towers** | Lattice pylons (4 STEEL_DARK uprights + X braces) on the top tier at r = 46 m, 34 m tall. The lamp head is a 6 × 3 m STEEL_DARK panel with a 3 × 6 grid of FLOODLIGHT lamp discs (lum 3), angled at the arena centre. Each tower owns a SpotLight, a shaft and a pool. One tower flickers in Scrap (0.3 s dropouts every 8–20 s). |
| **Scoreboard and LED boards** | No holograms. Boards are **LED dot-matrix**: `CanvasTexture` content, a shader with a dot mask `smoothstep(0.45, 0.3, length(fract(uv * res) - 0.5))`, lum 0.9, `fog: true`. 1 hanging board from the oculus trusses at y = 20 m (Scrap/Iron a single 6 × 3 m face, Steel+ a 4-face cube), plus 1 ribbon board above each gate. Content, redrawn on events: `ROUND 04`, `HOSTILES 18`, player name + rank title (`PIT DOG`), `HEADLINER: THE BRUTE`, hype ×N, `LEGENDARY` on a legendary drop. Sponsor plates use the weapon manufacturer words (Jakko, Vohl, …). Type follows §10 (Saira Stencil One numerals, Martian Mono labels), in accent and BONE only. |
| **Airlock gates** | Mob gates at the existing spawn points (E, S, W, plus diagonals if needed): a 6 × 5 m recess in the wall, two STEEL sliding doors (open 0.6 s), hazard-stripe painted lintel, and a status lamp above (idle `#5A5C5E` → THREAT pulsing 1.5 s before a spawn, plus a pooled red PointLight). |
| **Boss gate** | North, 12 × 9 m, 45° angled jambs (CONCRETE_LIT) with accent strips, split doors. Entrance sequence: gate lamps chase in THREAT, every spotlight swings to the gate over 1.2 s, the scoreboard switches to `HEADLINER`, the crowd jumps, the doors open. |
| **Cover props** | All `chamferBox`. Jersey barriers 1.1 m tall (trapezoid section). Concrete blocks 2 × 1.2 × 1 m. STEEL cargo containers 6 × 2.6 × 2.4 m with geometry ribs every 0.6 m. Square pillars 1.2 m. Ramps in CONCRETE with a HAZARD_PAINT edge strip. |
| **Boss plinth** | At the centre, octagonal, 10 m across, 0.6 m tall, CONCRETE_LIT top with a chamfer. Accent inlay ring from Steel upward. |
| **Hazards (later, M9)** | Iron: vent pulls (floor grates, downward haze). Steel: laser grids (THREAT beams 0.05 m between emitter posts, lum 3). Star: gravity pulse pads (accent ring pads, pulse lum 1.1 → 2). Void: shrinking ring (accent ring plus a haze wall closing in). |

Put the colours and per-league numbers in **one data file** `src/rendering/style.ts` (`PALETTE`, `LEAGUE_STYLE[league]`). World, sky, crowd and UI all read from it.

---

## 8. Enemies, bosses and gear

**Palette:** ARMOUR `#4E5249`, ARMOUR_LIT `#6E7366` on top plates, UNDERSUIT `#2D302A`, emissive THREAT only on things you should shoot. `surface: 'character'` (rim 0.35). Hit flash: emissive BONE at lum 1.2 for 60 ms, not white-out.

**Silhouettes** (read by shape first, then by the threat marks):
- **Grunt:** broad, low, wide pauldrons, short legs, horizontal visor slit.
- **Spitter:** tall and narrow, with a side tank (THREAT glow window in it) and a long forearm.
- **Bomber:** squat octagonal hull, large bright core (THREAT lum 2.5, pulse speeds up as it closes).
- **Elites:** a BONE stencil plate on the chest plus a second emissive band in the affix colour (Frozen = ice, Vampiric = THREAT, Shielded = BONE, Splitting = accent).
- **Bosses** are architecture that walks, at 2.5–4× grunt height. **Brute:** a bulkhead slab torso with hydraulic forearms and a shield slab. **Summoner:** an obelisk with 4 orbiting slabs. **Artillery:** a bunker on 4 legs with a mortar mast. Weak points are THREAT panels that slide open per phase (lum 2.5 pulsing).
- **Death:** no ragdoll. Slabs separate (2–4 pieces), a dust burst, and the emissive fades to black over 0.4 s.

**Gear growth (§11 of the plan):** item level adds **slabs, ribs, fins and antenna masts** in discrete steps (ilvl 1: 1 slab; 10: + fins; 20: + masts and double plates). Never organic horns. Rarity is the only colour on gear, as emissive seams: common none; uncommon to epic as a seam at lum 1.2; legendary as a seam at lum 2.5 plus slow motes.

**Viewmodel guns** (`src/player/weaponModels.ts`, target `docs/concepts/E-weapon-sheet.png`):
- Matte black chamfered plates (`#2C2F33`). Every bevel is split into a lighter **worn-edge** slot (`#4B5157`, bare steel showing through), so the light draws the edges.
- Extruded side-profile slabs for receivers and stocks, **faceted cylinders** in round steel (`#4A5158`) for barrels, bolts and rivets, and rubber grips with finger grooves.
- Detail: vent slots in the shrouds, top rails, hex rivets, and exposed cables on the camera side (left, -X).
- Light: **one orange indicator lamp per gun**, plus cyan micro-readouts on the rifle and the sniper. Rarity and element show only on the accent seam and the muzzle.
- Growth: item level adds **thin glowing seam strips on the growth fins**, a longer shroud and a bigger magazine.
- Guns carry a small self-lit floor (`GUN_SELF_LIT`), so they still read in the darkest corners of the grimdark arena (§15).

---

## 9. Loot beams and rarity

`RARITY_COLORS` stay. The rendering in `src/loot/view.ts` changes:

| Rarity | Beam height | Sheath (rarity colour, additive) | Core (70 % white + 30 % rarity) | Extras |
|---|---|---|---|---|
| common | 2.5 m | alpha 0.35 | lum 1.2 | ring |
| uncommon | 4 m | 0.5 | lum 2.0 | ring |
| rare | 5.5 m | 0.6 | lum 2.6 | ring, slow upward motes |
| epic | 7 m | 0.7 | lum 3.2 | ring + motes |
| legendary | 10 m | 0.8 | lum 4.0 (pulse to 5) | double ring (outer dashed, counter-rotating), motes, **spectacle** |

- Beams use `fog: false` and render after the haze, so they always cut through it.
- Sheath radius 0.12 m and core radius 0.03 m, both fading to 0 alpha at the top. Ground ring at lum 1.5.
- **Legendary spectacle:** 2 spotlights swing onto the drop for 2 s, the crowd flashes 3 %, the accent ribbon flashes, and the scoreboard shows `LEGENDARY`.
- Bloom is threshold-based, so "extra bloom per rarity" is simply the core lum above. No selective bloom pass is needed.

---

## 10. HUD and UI language (`src/ui/*`)

Everything Borderlands about the current UI goes: Bangers, Oswald, the 8-way `--ink` text-shadow, skewed bars, gradient panels and the angled weapon card. The new language is **stadium scoreboard and station safety signage**: wide grotesk, stencil numerals, wide mono, flat opaque rectangles, hairlines, hazard tabs and segmented gauges.

### 10.1 Type (Google Fonts)

```
https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=Martian+Mono:wght@400;700&family=Saira+Stencil+One&display=swap
```
| Face | Use | Settings |
|---|---|---|
| **Archivo**, expanded | names, titles, boss names, menu headings, weapon names | `font-stretch: 125%`, weight 760–900, tracking −0.01em |
| **Saira Stencil One** | round numbers, banners, scoreboard numerals, league marks, big rewards | never body text, never below 28 px |
| **Martian Mono** | every number, label and stat: ammo, health, deltas, prompts | 400/700. Labels in caps at +0.12em, 10–12 px. Values at 13–20 px; ammo at 52 px |

Banned: Bangers, Oswald, any condensed display face, any text outline or ink shadow, any italic or skew.

### 10.2 Colour and panels

CSS variables: `--bone #ECEAE4; --panel rgba(20,21,22,.88); --panel-solid #141516; --dim #8E8C86; --label #9A9890; --rule #3A3C40; --shield #CFE3EA; --health #E0402F; --accent <league>; --threat #FF2238`.
- **Panel:** `--panel` fill, **0 radius**, no blur, no gradient, a 2 px `--bone` top rule. Padding 10–16 px.
- **Hazard tab:** a `repeating-linear-gradient(-45deg, --panel-solid 0 6px, --accent 6px 12px)` strip, 5–10 px tall. It marks warnings, perks, the boss bar underline and banner edges.
- **Segmented gauge:** `repeating-linear-gradient(90deg, fill 0 Npx, transparent Npx N+2px)` over a `#2E3134` track. Use it for shield, health, ammo pips and hype.
- **Keycap:** a 2 px `--bone` square border with the key in mono bold, then the action in mono caps (`[E] TAKE`).
- Text legibility comes from the panel behind it, **never** from text-shadow. The single exception is the crosshair, which gets a 50 % `#141516` 1 px backing.
- Layout snaps to an 8 px grid, 32 px screen margins, everything upright and axis-aligned.

### 10.3 Components

| Component | Spec |
|---|---|
| **Crosshair** | 4 bars, 2 × 12 px BONE, 8 px centre gap, no dot. Spread widens the gap. **Hit marker:** 4 small corner brackets (L-shapes) for 120 ms. Crit: brackets in `--accent`. Kill: brackets plus a 1-frame filled 6 px square. |
| **Shield / health** | Bottom-left panel 340 px. Row `01 · SHIELD` label + `184 / 200` value, then a 20-segment gauge in `--shield`. Row `02 · HEALTH`, then a 10-segment, taller gauge in `--health`. Footer: `LV 12`, a 2 px XP line in `--accent`, grenade count. Shield break: the shield gauge flashes BONE, then empties segment by segment. Low health (< 25 %): the hazard tab appears on top of the panel, blinking at 2 Hz. |
| **Ammo** | Bottom-right panel 330 px. Mag in Martian Mono 700 at 52 px, `/ reserve` at 18 px in `--label`, slot indicator `SLOT 1 ■ 2 □`. A pip gauge (one segment per round; mags over 36 become a continuous segmented bar). Weapon name in Archivo expanded 14 px after a rarity square, then `SHOTGUN · FIRE · ILV 14` mono. Reload: pips refill left to right, with a hazard tab across the panel while reloading. |
| **Weapon card** (pickup / compare) | A **cargo manifest**, 300–400 px. Top band in the rarity colour, with `EPIC` left and `ILV 14` right, mono bold in `--panel-solid`. Name in Archivo expanded 800. Sub-line `ARCHETYPE · ELEMENT · MAKER`. A **stat table** with columns `STAT / THIS / YOURS / Δ`, deltas as `▲ 17%` in BONE or `▼ 17%` in `--dim` (glyph and lightness, never red/green). An element row with a colour square. A **perk** box with a rarity-colour hazard tab on top. Footer: a procedural barcode, serial `SB-<ilv>-<id>-<rarity initial>` and keycaps `[E] TAKE` / `[HOLD E] SCRAP`. No tilt and no big comic name. |
| **Boss bar** | Top centre, 640 px. Row: `HEADLINER` tag (accent fill, panel text), boss name in Archivo expanded 22 px, then `PHASE 2/3 · 61 %` mono on the right. A 4 px BONE shield layer over a 14 px THREAT health bar, with 3 px phase notches in `--panel-solid`, and a hazard tab underline. Damage chips drain with a 300 ms lag segment in BONE. |
| **Round / wave plate** | Top-left panel: stencil `04` in `--accent` at 48 px, `ROUND · SCRAP LEAGUE` label and `WAVE 3/3 · 06 LEFT`. |
| **Hype / crowd** | Top-right panel 210 px: 10-segment accent gauge, `HYPE ×3`, then the latest crowd event line (`MULTIKILL · +240 STANDING`). |
| **Damage numbers** | **Tags**, not floating comic text. Mono 700 on a small `--panel-solid` rectangle, 13–15 px. Crit: inverted (panel text on a BONE fill), 20 px, with a tiny `CRIT` label. Elemental damage: the number in the element colour. Motion: rise 24 px over 0.6 s and cut out (no bounce, no scale pop). |
| **Pickup prompt** | Keycap + action, centred under the crosshair at +80 px. |
| **Round banners** | Full-width **LED ribbon**: `--panel-solid` band with 10 px hazard tabs at top and bottom. `ROUND 04` in Saira Stencil One 72 px in `--accent`, then mono lines `SCRAP LEAGUE · 3 WAVES · 28 HOSTILES` and `HEADLINER: THE BRUTE`. Slides in from the left in 180 ms (ease-out), holds, then slides out to the right. Boss intro: a THREAT-fill band with `HEADLINER ENTERS · GATE N` and the name in Archivo 36 px. Cleared: a BONE-fill band with `+1 480 STANDING` in stencil. No scale pop, no rotation. |
| **Skill tree** | A floor-plan grid (`#1C1E21` with 40 px `#26282B` grid lines). Nodes are 72 px square **plinths** labelled with a stencil code (`A1`). Invested nodes in BONE fill, available in `#2E3134`, locked as a dashed outline. Connections are orthogonal 2 px lines only. Rank = 5 small blocks under the node, filled in accent. A branch header in mono caps (`A · DAMAGE`), a points chip in accent top-right, and a detail panel bottom-right (`RANK 3/5`, `+24 % → +32 %`, `[LMB] INVEST`). |
| **Start screen** | Dark, with one floodlight shaft (CSS gradient) and a closed gate silhouette with an accent lintel. `Orbital Concourse` in Archivo 900 at 125 % width. Sub-line `ORBITAL COLOSSEUM · SEASON 01` in mono. A menu of numbered mono rows (`01 ENTER THE PIT`, `02 QUARTERS`, `03 LOADOUT`, `04 SETTINGS`); the selected row is a BONE fill with panel text. League plaque bottom-left (hazard tab plus `SCRAP LEAGUE · RANK 04/25 · PIT DOG · NEXT: ROOKIE`). `CLICK TO ENTER ▸` bottom-right. |
| **Game over** | The same ribbon language: THREAT band `ELIMINATED · ROUND 06`, then a manifest-style recap table (kills, best weapon as a mini card, standing earned). |
| **Level up** | A BONE ribbon `LEVEL 13 · +1 SKILL POINT` with a short accent pip burst. No gold flash. |

Motion everywhere: linear slides and segment fills, 120–200 ms. No bounce or elastic easing, no wobble.

---

## 11. FX (`src/rendering/fx.ts`, `particles.ts`)

| FX | Rule |
|---|---|
| **Tracers** | Thin: width 0.012–0.02 m (shotgun pellets 0.01). Core 70 % white + element colour, lum 2.5. Life **0.06 s**. Element `none` uses BONE-warm `#FFE9B0` (current). |
| **Muzzle flash** | 2 frames: a flat 4-point star quad, lum 6, element tint, plus the pooled PointLight. |
| **Impact: concrete** | Grey dust puff (normal blending, `#8E8C86`, soft round sprites with dithered edges, 0.3 s), 6–10 hot sparks (lum 3, gravity), 3 flat-shaded concrete chips. **Decal:** a dark scorch square with ragged alpha, `#1C1E21` at 60 %, no comic star shape, fading over 9 s. |
| **Impact: enemy** | Sparks plus 4–6 THREAT flecks. Shield hit: a flat BONE ring flash (lum 1.5, 80 ms). |
| **Explosion** | 1) a white flash sphere, lum 6, 0.08 s; 2) an element-tinted shell expanding 0.25 s, back faces only, fresnel alpha; 3) a grey dust ring along the floor (normal blend, 1.5 s); 4) a lingering haze puff that raises the ground-haze alpha locally for 2 s; 5) shake 0.4. No toon smoke balls, no outlines. |
| **Fire** | Orange-red flame tongues (additive cards) plus embers. Burning enemies get flickering emissive seams. |
| **Shock** | White-cyan jagged line arcs (3–5 segments, re-jittered every 30 ms), lum 3. |
| **Ice** | Pale cyan flat-shaded shards. Frozen enemies get a desaturated tint and a BONE rim boost. |
| **Screen feedback** | Damage: an edge vignette in `--health` at 0.25 for 200 ms plus a CA spike (§4). **No full-screen red flash.** Shield break: a BONE edge flash. Level up: none in-world (UI only). |

---

## 12. Per-league variation

| | **Scrap** | **Iron** | **Steel** | **Star** | **Void** |
|---|---|---|---|---|---|
| Ranks | Fodder → Pit Dog | Rookie → Enforcer | Veteran → Champion | Starblade → Immortal | Myth → Eternal |
| Accent | `#FF5F1F` | `#FFC61A` | `#1FD1C1` | `#E8368F` | `#8C6CFF` |
| Floodlight towers | 2 (1 flickers) | 4 | 4 + wall uplights | 6 + 2 sweeping beams | 8, cold white `#E6E2FF` |
| Real SpotLights (high) | 2 | 4 | 4 | 6 | 8 |
| Fog density | 0.016 | 0.013 | 0.011 | 0.009 | 0.006 |
| Shaft intensity | 0.16 | 0.13 | 0.12 | 0.12 | 0.10 |
| Crowd | 1 500 · 25 % | 3 000 · 45 % | 5 000 · 65 % | 7 500 · 85 %, flashes ×2 | 10 000 · full, UV wristbands |
| Planet in oculus | none (stars) | quarter limb | half disc | large, ringed | eclipse, white corona |
| Concrete | rough formwork, patched steel plates, tarps | painted hazard bands, steel railings | clean poured, chamfered steel cladding | **polished floor** (sheen 0.2, floor only) | black monolith concrete, albedo `#2E2F33` |
| Accent dressing | pillar strips only | + LED coping ribbon, sponsor plates | + plinth inlay ring | + ribbon chase FX, pyro vents on round start | + floor ring, wristbands, gate jambs |
| Scoreboard | single LED panel | panel + gate ribbons | hanging 4-face cube | cube + ring board | cube, accent-only text |
| Hazard (M9) | none | vent pulls | laser grids | gravity pulse pads | shrinking ring |
| Hub floor | cargo-bay bunk, flickering lamp | room with window, gear rack | lounge, view of the arena | penthouse, holo-free LED wall of fights | private deck under the eclipse |

Each tier inside a league adds one visible step: +10 % crowd, then one more banner, a lit gate or a sponsor plate (data in `LEAGUE_STYLE[league].tiers[i]`).

**Hub:** the same material rules, but the luxury reads as **warmth and quiet**: 2700 K lamps (`#FFD9A8`), soft `flat` fabric surfaces, wood-tone albedo `#7A5A44` used sparingly, bigger windows onto the pit. Each rank adds a lamp, a prop or a window. Nothing is replaced.

---

## 13. File map (for the implementing agent)

| File | Change |
|---|---|
| `src/rendering/style.ts` (new) | `PALETTE`, `LEAGUE_STYLE`, `glowLum()`, rarity beam table |
| `src/rendering/materials.ts` | 2-band soft ramp; surface injection (mottle, grime, sheen, rim); drop hatching |
| `src/core/types.ts` | optional `surface/mottle/sheen/rim` on `ToonOptions` (non-breaking); colours unchanged |
| `src/rendering/pipeline.ts` | RenderPass instead of InkPass; new light rig; FogExp2; bloom 0.7/0.6/1.0; extended grade (chroma-protected sat, contrast, grain, dither); no snow |
| `src/rendering/inkPass.ts` | unused (kept) |
| `src/rendering/sky.ts` | dark dome, white stars, pale planet, no aurora; roof ring lives in world |
| `src/rendering/shafts.ts` (new) | cone shafts, dust motes, light pools |
| `src/rendering/haze.ts` (new) | ground haze quads, stand haze band (replaces `snow.ts`) |
| `src/world/props.ts` / `index.ts` | concrete colosseum per §7, `chamferBox`, gates, plinth, towers, LED boards |
| `src/world/crowd.ts` (new) | instanced SDF-quad crowd with hype, wave and flashes |
| `src/rendering/fx.ts`, `particles.ts` | §11 |
| `src/loot/view.ts` | §9 beam table |
| `src/ui/styles.ts`, `hud.ts`, `weaponCard.ts`, `screens.ts`, `damageNumbers.ts` | §10, full replacement of fonts and CSS; delete `--ink` vars |

---

## 14. Do / Don't (so we don't drift back into Borderlands)

**Do**
- Let light and haze draw the form: chamfers, value contrast, back-rims.
- Keep the world grey and spend saturation only on loot, threat, the league accent and elements.
- Use straight lines, slabs and 45° chamfers. Keep things heavy and upright.
- Set glow brightness by luminance target, so the brightness hierarchy holds.
- Make the crowd react to everything the player does.
- Keep UI flat, opaque, gridded and mono-numbered, with hazard tabs for emphasis.

**Don't**
- Draw black (or any) outlines on geometry, characters or text.
- Add hatching, halftone or any screen-space pattern on surfaces.
- Use 3+ hard cel bands or a saturated warm/cold colour contrast.
- Use comic or condensed display fonts, skewed or tilted panels, or bouncy scale pops.
- Use the accent colour on loot, enemies or UI health, or use THREAT on anything friendly.
- Add snow, aurora, lanterns, wooden huts or cartoon smoke puffs.
- Put rounded corners, glassmorphism blur or gradient fills on UI panels.

---

## 15. Grimdark revision (2026-10-15)

User feedback: *too bright, not enough like the chosen design; add some Warhammer 40k mood.* The new mood target is `docs/concepts/D-grimdark-arena.png`: a black arena, pools of hard sodium light in deep shadow, smoke and ash, red warning lamps and fire, and a heavy gothic-industrial build.
**No Games Workshop IP.** That means no skulls, aquilas, purity seals, religious iconography or chapter symbols. The vocabulary is our own: black concrete, rusted steel, buttresses, chains, cables, grates, burn barrels, braziers, red lamps, sodium floods, tattered sponsor banners, rust streaks and oil stains.
The enemy and boss **armour design stays** (the layered matte plates from C). Only the plates got darker and the threat marks brighter.

### 15.1 Measured result

Mean screen luma (sRGB, 320×180 downsample of the canvas, `window.__rendering.measure()`), Scrap League, three fixed fight views (`[0,1.65,23.5 → 0,1.2,0]`, `[-10,1.65,10 → 8,2,-12]`, `[18,1.65,-14 → -10,2,6]`):

| | before (brutalist) | after (grimdark) |
|---|---|---|
| mean of the three views | **0.362** | **0.090 (25 % of before)** |
| per view | 0.321 / 0.368 / 0.397 | 0.084 / 0.076 / 0.110 |
| 40th percentile (p40) | 0.25–0.33 | 0.047–0.066 |

The darkest 40 % of each frame sits at or under ≈ 0.06. The highlights are the sodium pools and shafts, the cold slit on the plinth, fire, lamps and threat emissives.

### 15.2 Palette (`GRIM` in `src/rendering/style.ts`)

`PALETTE` is unchanged, because gear, the viewmodel and loot still use its STEEL tokens. World code uses `GRIM`:

| Token | Hex | Role |
|---|---|---|
| CONCRETE / _LIT / _DARK | `#34302C` / `#48423B` / `#221F1C` | black concrete (linear lum ≤ 0.06) |
| FLOOR | `#3A3631` | play floor (oil stains, grated slabs) |
| STEEL / STEEL_DARK | `#3E3029` / `#1E1B19` | rusted steel |
| RUST | `#7A3A1A` | rust streak tint (shader) |
| SODIUM | `#FF8A2E` | ≈ 2200 K floodlights, shafts, pools (Void keeps a cold `#C9C2FF`) |
| SODIUM_WARM | `#FFA552` | ≈ 2700 K twin wall lamps |
| FIRE | `#FF6A1C` | burn barrels and braziers |
| WARN_RED | `#D8200E` | red warning lamps (architecture). THREAT `#FF2238` stays hostile-only |
| SLIT | `#9DB6D6` | cold light through the dome slit (key, plinth shaft) |
| HAZE | `#2A1A10` | fog: dark warm smoke |
| SMOKE / CLOTH / ASH | `#3A2E25` / `#43100C` / `#8A8580` | ground haze / banner cloth / falling ash |

### 15.3 Light rig (`LIGHT` in style.ts, `pipeline.ts`, `stage.ts`, `fire.ts`)

| Light | Before | Grimdark |
|---|---|---|
| Key (directional, shadows) | FLOODLIGHT, 4.2 | **SLIT `#9DB6D6`, 1.4**: faint cold light from above |
| Hemisphere | `#3A3E45` / `#6F6D68`, 7.5 | `#2A3446` / `#5A3018` (cold sky, warm fire bounce), **4** |
| Ambient | HAZE, 3.0 | `#3A2A20`, **0.6** |
| Floodlight spots | 2600 cd, 0.38 rad, penumbra 0.6 | **36 000 cd × towerGain, 0.13 rad, penumbra 0.45**: hard pools about 5 m across |
| Floor pool decal | 0.18 | 0.14 × towerGain |
| Shafts | gain 3.6 | gain **3.2**, radius 5.2 m, intensity × towerGain |
| Slit | none | 1 cold SpotLight (9000 cd, 0.13 rad) + shaft + pool on the boss plinth, every league |
| Fire | none | pooled flickering PointLights (`FIRE`, 40 cd, 13 m), **high 6 / low 3** (`QUALITY_PRESETS.fireLights`), the container-roof fires first; an additive warm floor pool per barrel |
| Gate lamps | idle grey | idle **dim WARN_RED** (lum 0.5) + red smoke halo + 2 caged red jamb lamps; THREAT strobe on a spawn (unchanged) |
| Boss under-glow | pool ×1.3, light 6 | pool **×3.0**, light **30** at 0.7 m in front of the boss (lights it from below) |

### 15.4 Grade (`GradeShader` in pipeline.ts)

exposure **1.25** · soft toe `c *= l / (l + 0.014)` (crushes the blacks without clipping) · contrast 1.1 · lift (0.0012, 0.001, 0.0009) · shadow tint (1.0, 0.98, 0.97), highlight tint (1.06, 0.99, 0.88) · saturation `mix(0.62, 1.15, smoothstep(0.08, 1.2, lum))` · vignette **0.6**, `smoothstep(0.18, 0.8, r)` · grain **0.05** · bloom unchanged (0.7 / 0.6 / 1.0). Background `#030304`.

### 15.5 Atmosphere

- **Fog** `FogExp2(#2A1A10)`, density by league: Scrap 0.022, Iron 0.020, Steel 0.018, Star 0.017, Void 0.016.
- **Stand haze band:** colour `#4A2C18`, alpha 0.5, falloff `(1 - t)^0.7`. It is warm lit smoke, so the stands and pillars read as silhouettes against it.
- **Ground haze** in SMOKE at 0.12, and the haze folded into the surface shader at `(0.016, 0.012, 0.009)`, strength 0.34–0.4.
- **Smoke columns** rise from every lit fire (a second `Puffs` pool, `#2C231C`, alpha 0.32). Gate puffs and **steam vents** from the door seals every 5–14 s use dark steam `#4A423B`.
- **Embers** rise from the fires (22 per site, additive). **Ash** (700 flakes over the pit, 7 % of them hot orange) falls slowly with sway.
- **Sky:** a dome from `#020203` to `#07070A`, stars ×0.5, station windows dimmed to sodium ×0.22. The planet is smaller and dimmer: Scrap gets a small dead moon (`dead`, 74), then quarter 105, half 125, large 160, eclipse 140. Its lit side is about lum 0.3 (desaturated, with craters).

### 15.6 Dressing

- **Surface shader** (`materials.ts`, one program, `concourse-c-surface-v2-grim`). `uSurf2 = (seams, rust, oil, grate)`:
  - rust streaks: vertically stretched noise toward `uRust`, on concrete 0.25–0.35, steel 0.45–0.8 and barrels 1;
  - oil stains on the floor plane;
  - grated slabs on the floor: 20 % of the 4 m cells plus the drain ring at r 29–30.6, with 9 cm bars over a black pit that fade to their average value where they would alias.
- **Characters** (surfaces with a rim) get a small readability fill, `uCharFill (0.42, 0.38, 0.35) × albedo`, and a cool rim `#93A8C4`.
- **Buttresses:** every pillar (except the two at the boss gatehouse) gets a 2.2 × 7.2 m footing above the wall coping, a wedge set-back, steel bands at 6.4, 9.2, 16 and 22.5 m, a riveted plate and an outer rib. The wall gets a rusted kick band and a steel rib at every panel seam.
- **Chains** (`chains.ts`): one InstancedMesh of about 3k links. Swags between the pillar fronts at 21.5 m and 17.2 m, hangers with hooks from the oculus trusses and the roof lip.
- **Cables** (`props.cables`): three sagging tubes per span under the tier-1 and tier-2 faces.
- **Burn barrels** (`BARREL_SITES`): one on each cargo container roof (fire in the middle of the pit), plus 4 on the floor in front of the sponsor plates. They are solid: floor barrels are 0.95 m boxes, roof barrels sit on the containers. **Braziers** stand on the wall coping.
- **Banners** (`banners.ts`): 2.3 × 8.2 m oxblood cloth on poles between the pillars. Each has an accent band, our own pit crest (a ring with stacked chevrons), a sponsor word in stacked stencil letters, and a torn, holed hem (alpha-tested). The vertex shader sways them.
- **Glows** (`glows.ts`): one additive instanced billboard batch draws the flames (noise tongues), the smoke halos and the lamp dots. Flicker modes: steady, fire, pulse, failing lamp.
- **Lamps:** red warning lamps on the pillar fronts (some failing) and twin sodium wall lamps with halos.
- **Crowd:** darker (`#0A0A0A` to `#1B1A19`), with 1.2 % holding up a flickering lighter or torch.
- **LED boards** dimmed to lum 0.55, with darker housings.
- **FX:** impact dust `#4A433C` and darker debris (unlit sprites must not glow).

### 15.7 Enemies (`src/enemies/models.ts`, brightness only)

Same models and plating. Plates ×0.8 (ARMOUR, ARMOUR_LIT, UNDERSUIT), visor lum 2.0 → **3.0**, every `threatK` tier ×1.15, cores and weak points at lum 2.8. The rim is 0.5 in the cool rim colour. Bosses get the stronger red under-glow from §15.3.

### 15.8 Per-league deltas: more light sources, not more brightness

The per-tower spot, shaft and pool gain is `towerGain`, so `towers × towerGain ≤ 2` holds in every league (tested in `tests/world/grimdark.test.ts`).

| | Scrap | Iron | Steel | Star | Void |
|---|---|---|---|---|---|
| towers × towerGain | 2 × 1 | 4 × 0.5 | 4 × 0.5 | 6 × 0.3 | 8 × 0.17 |
| fires (roof barrels, floor barrels, then braziers) | 6 | 8 | 10 | 12 | 16 |
| red lamps / sodium wall lamps | 8 / 6 | 12 / 8 | 16 / 12 | 20 / 16 | 24 / 20 |
| banners | 6 | 8 | 10 | 12 | 12 |
| fog | 0.022 | 0.020 | 0.018 | 0.017 | 0.016 |
| planet | dead moon | quarter | half | large | eclipse |
| measured mean (3 views) | 0.090 | 0.107 | 0.109 | 0.119 | 0.129 |

Everything else from §12 stays: accent, ribbon, inlay, cube board, crowd size and hazards.

### 15.9 Performance

1280×720, high preset, Scrap League, 25 enemies alive: **about 12 ms per frame** with a forced GPU sync every frame (`readPixels`), sim included. That is at or above 60 fps. The new dressing adds 4 draw calls (glows, chains, embers, ash), one smoke Points pool, 12 banner meshes, and 7 lights in a fixed count (6 fire PointLights and 1 slit SpotLight), so a league switch never recompiles shaders because of fire.

Screenshots: `docs/screenshots/13-grimdark-fight.png`, `14-grimdark-boss.png`, `15-grimdark-pitstop.png`. Look-dev helpers: `window.__rendering.measure()` for luminance, and `window.__cam` / `window.__step` as before.
