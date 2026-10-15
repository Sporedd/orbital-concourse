# Enemy armour kit: changes outside src/enemies (for the lead to apply)

The enemies now share one armour kit (`src/enemies/armourKit.ts`). Nothing outside `src/enemies`
has to change for the game to work; the diffs below are polish for the co-op mirror and the
art-direction doc.

## 1. `src/net/enemyMirror.ts`: knees/elbows and the far-glow LOD on mirrored enemies

Mirrored enemies already build the new rigs, but they only swing hips/shoulders (knees and
elbows stay at their rest bend), and their visor slits never switch to the thickened far LOD,
so a client sees thinner glows than the host beyond 18 m.

```diff
 import {
   DISC_GEO, RING_GEO, SPHERE_GEO,
-  buildArtillery, buildBomber, buildBrute, buildGrunt, buildSpitter, buildSummoner, type Rig,
+  buildArtillery, buildBomber, buildBrute, buildGrunt, buildSpitter, buildSummoner, updateGlowLod, type Rig,
 } from '@/enemies/models';
+import { poseRun } from '@/enemies/pose';
@@ (MirrorEnemy.update)
     if (!this.state.alive) {
       this.deathTime += dt;
       this.deathPose();
     }
     this.tint();
+    updateGlowLod(this.rig, _camPos.setFromMatrixPosition(this.ctx.camera.matrixWorld));
   }
@@ (MirrorEnemy.animate)
     const legAmp = kind === 'artillery' ? 0.25 : kind === 'spitter' ? 0.35 : 0.6;
-    for (let i = 0; i < rig.legs.length; i++) {
-      // biped: alternate; quadruped: diagonal pairs (0/3, 1/2)
-      const sign = rig.legs.length === 4 ? (i === 0 || i === 3 ? 1 : -1) : i % 2 === 0 ? 1 : -1;
-      rig.legs[i].rotation.x = sw * legAmp * k * sign;
-    }
+    if (rig.parts.knee0) {
+      // trooper rigs (grunt, spitter, bomber, brute): the shared run cycle with knees and elbows
+      poseRun(rig, this.walkPhase, k, { stride: legAmp + 0.2 });
+    } else {
+      for (let i = 0; i < rig.legs.length; i++) {
+        // biped: alternate; quadruped: diagonal pairs (0/3, 1/2)
+        const sign = rig.legs.length === 4 ? (i === 0 || i === 3 ? 1 : -1) : i % 2 === 0 ? 1 : -1;
+        rig.legs[i].rotation.x = sw * legAmp * k * sign;
+      }
+    }
```

and next to the other module-level temporaries:

```diff
+const _camPos = new THREE.Vector3();
```

(The existing arm loop after it can stay: it eases the shoulders toward the attack pose and
otherwise follows the swing poseRun just set.)

## 2. `docs/ART_DIRECTION.md`: record the new enemy look

§1.4 and §8 still describe the old blob models and a THREAT-red visor. Suggested replacement
text (the lead or the art owner decides):

§1.4 table, replace the four rows with:

| Token | Hex | Role |
|---|---|---|
| plate / lit / dark | `#313F2C` / `#3B4A36` / `#222A1F` | olive-gunmetal plates (chroma ≤ 11 %; the warm fill and the grade's low-light desaturation pull them to olive-grey on screen) |
| worn edge | `#475641` / `#52624B` / `#343E31` | every 45° chamfer of a plate (the light draws the edge, no outlines) |
| undersuit | `#0F110E` | matte black rubber at neck, elbows, hips, knees |
| `ENEMY_GLOW` | `#FF5F1F` | visor slit, chest chevrons, status marks (the HUD accent orange, user's pick) |
| `THREAT` | `#FF2238` | weak points, muzzles, payloads, tank windows, boss under-glow |

§8 Silhouettes, replace the mob/boss bullets with:

- **One kit:** a 7-head trooper (1.85 m): layered chamfered plates (pectoral shells over three
  abdomen segments, rounded two-tier pauldrons, bracers, thigh plates, knee caps, shin guards),
  black undersuit at the joints, an angular full-face helmet with a crest fin, swept-back skull
  and a narrow orange visor slit, two short orange chevrons on the chest, small orange status
  marks on the right forearm and left thigh. Rank and threat read from glow colour, glow
  strength and plate count, not from size alone.
- **Grunt:** the line trooper, gunmetal blades along both bracers.
- **Spitter:** taller and narrower, wrap-around visor, long bracers, a tall tank over the left
  shoulder with THREAT windows, a launcher over the right shoulder with a red muzzle.
- **Bomber:** a small, stocky sapper (1.3 m), no chevrons, a THREAT payload canister strapped
  across the chest (blinks faster on the fuse), a fuse antenna with a red spark.
- **Brute:** the trooper at 3.7 m × 1.35, two extra plate tiers (stacked pauldrons, gorget,
  tassets, heavy thighs and boots), a 2.2× crest, hydraulic forearms, a shield slab on the left
  forearm, a THREAT reactor on the sternum, red under-glow vents at belt and heels.
- **Summoner:** a floating commander: trooper upper body, a three-tier tasset skirt with a
  red-glowing hem and thruster, a crown of fins, a THREAT gem in the chest (weak point), four
  orbiting slabs with orange slits.
- **Artillery:** a siege walker: stacked carapace on four armoured legs (pauldron hip shells,
  knee caps, shin guards), a big trooper helm at the front, orange glacis chevrons, the mortar
  mast with a THREAT muzzle ring, the THREAT core caged on its back.
- **Glow LOD:** beyond 18 m every visor/chevron slit swaps to a thickened twin (≥ 4.8 cm) so it
  stays at least a pixel tall at 30 m (there is no MSAA); up close the slit runs at 0.7 of the
  far brightness so it stays a sharp line.

§15.7: "visor lum 3.0" now reads "mob slits: orange, lum 3.4 far / 2.4 near; boss slits lum 3.0;
THREAT parts 2.8 (mobs) / 3.2 (bosses); rim 0.3 (0.5 washed the thin limbs out to grey)".
