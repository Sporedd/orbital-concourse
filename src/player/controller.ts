/**
 * First-person movement + camera: mouse look, WASD, sprint, jump (coyote time + buffer),
 * gravity, capsule collision, head bob, landing dip, sprint FOV and death camera.
 */
import * as THREE from 'three';
import { CAMERA, PLAYER } from '@/core/config';
import type { GameContext } from '@/core/types';
import { clamp, damp, lerp, smooth } from './shared';

// ---- tunables ---------------------------------------------------------------
export const MOUSE_SENSITIVITY = 0.0022; // rad per pixel
const PITCH_LIMIT = Math.PI / 2 - 0.03;
const COYOTE_TIME = 0.12;
const JUMP_BUFFER_TIME = 0.12;
const GROUND_ACCEL = 18; // 1/s, exponential approach to the wish velocity
const GROUND_FRICTION = 14; // 1/s, when no input on the ground
const AIR_CONTROL = 0.3; // fraction of ground accel available in the air
const AIR_DRAG = 0.25; // 1/s, momentum loss in the air without input
const SPRINT_FOV_BONUS = 9; // degrees
const STEP_DOWN = 0.35; // snap down ledges/ramps this high while walking
const BOB_PER_METRE = 1.8; // bob phase (rad) per metre travelled
const BOB_VERTICAL = 0.03;
const BOB_LATERAL = 0.022;
const LAND_SPRING = 220;
const LAND_DAMPING = 22;
const DEATH_EYE_HEIGHT = 0.45;
const DEATH_ROLL = 0.5;
const DEATH_TIME = 0.9;
/** Gear set hook 'voidrunner_dash': a sprint-jump becomes a blink dash. */
export const DASH_SPEED = 18;
export const DASH_COOLDOWN = 4;

export class Controller {
  /** Feet position (shared with PlayerState.position). */
  readonly position: THREE.Vector3;
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  /** Recoil offsets added on top of the view; the weapon system kicks and recovers them. */
  recoilPitch = 0;
  recoilYaw = 0;
  onGround = false;
  sprinting = false;
  /** Voidrunner set bonus active (set by the player every frame from the gear hooks). */
  dashEnabled = false;
  dashCooldown = 0;
  /** True on the frame a dash fired (the player shakes the camera). */
  dashedThisFrame = false;
  horizontalSpeed = 0;
  /** 0..~1.25, smoothed movement intensity used for bob (camera + viewmodel). */
  moveAmount = 0;
  bobPhase = 0;
  /** Mouse delta this frame (pixels), for viewmodel sway. */
  lookDX = 0;
  lookDY = 0;
  /** Seconds remaining during which sprint is suppressed (set while firing). */
  sprintBlock = 0;

  private coyote = 0;
  private jumpBuffer = 0;
  private landOffset = 0;
  private landVel = 0;
  private deathT = 0;
  private readonly target = new THREE.Vector3();

  constructor(private readonly ctx: GameContext) {
    this.position = ctx.world.playerStart.clone();
    ctx.camera.rotation.order = 'YXZ';
  }

  resetTo(start: THREE.Vector3, yaw: number): void {
    this.position.copy(start);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.onGround = false;
    this.sprinting = false;
    this.moveAmount = 0;
    this.landOffset = 0;
    this.landVel = 0;
    this.deathT = 0;
    this.coyote = 0;
    this.jumpBuffer = 0;
  }

  look(active: boolean): void {
    const { dx, dy } = this.ctx.input.mouseDelta();
    if (!active) {
      this.lookDX = 0;
      this.lookDY = 0;
      return;
    }
    this.yaw -= dx * MOUSE_SENSITIVITY;
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
    this.pitch = clamp(this.pitch - dy * MOUSE_SENSITIVITY, -PITCH_LIMIT, PITCH_LIMIT);
    this.lookDX = dx;
    this.lookDY = dy;
  }

  move(dt: number, active: boolean, speedMult: number): void {
    const input = this.ctx.input;
    const v = this.velocity;
    this.dashedThisFrame = false;
    if (this.dashCooldown > 0) this.dashCooldown = Math.max(0, this.dashCooldown - dt);

    let fwd = 0;
    let strafe = 0;
    if (active) {
      if (input.isDown('KeyW')) fwd += 1;
      if (input.isDown('KeyS')) fwd -= 1;
      if (input.isDown('KeyD')) strafe += 1;
      if (input.isDown('KeyA')) strafe -= 1;
    }
    const len = Math.hypot(fwd, strafe);
    if (len > 1) {
      fwd /= len;
      strafe /= len;
    }
    const hasInput = len > 0.01;

    this.sprintBlock = Math.max(0, this.sprintBlock - dt);
    this.sprinting = active && input.isDown('ShiftLeft') && fwd > 0 && this.sprintBlock <= 0;
    const speed = (this.sprinting ? PLAYER.sprintSpeed : PLAYER.walkSpeed) * speedMult;

    // forward = (-sin, 0, -cos), right = (cos, 0, -sin)
    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    const wishX = (-s * fwd + c * strafe) * speed;
    const wishZ = (-c * fwd - s * strafe) * speed;

    if (this.onGround) {
      const k = damp(hasInput ? GROUND_ACCEL : GROUND_FRICTION, dt);
      v.x += (wishX - v.x) * k;
      v.z += (wishZ - v.z) * k;
    } else if (hasInput) {
      const k = damp(GROUND_ACCEL * AIR_CONTROL, dt);
      v.x += (wishX - v.x) * k;
      v.z += (wishZ - v.z) * k;
    } else {
      const k = damp(AIR_DRAG, dt);
      v.x -= v.x * k;
      v.z -= v.z * k;
    }

    // jump with buffer + coyote time
    if (active && input.justPressed('Space')) this.jumpBuffer = JUMP_BUFFER_TIME;
    else this.jumpBuffer -= dt;
    if (this.onGround) this.coyote = COYOTE_TIME;
    else this.coyote -= dt;
    let jumped = false;
    if (this.jumpBuffer > 0 && this.coyote > 0) {
      v.y = PLAYER.jumpSpeed;
      this.jumpBuffer = 0;
      this.coyote = 0;
      this.onGround = false;
      jumped = true;
      if (this.dashEnabled && this.sprinting && hasInput && this.dashCooldown <= 0) {
        const h = Math.hypot(wishX, wishZ) || 1;
        v.x = (wishX / h) * DASH_SPEED;
        v.z = (wishZ / h) * DASH_SPEED;
        this.dashCooldown = DASH_COOLDOWN;
        this.dashedThisFrame = true;
      }
    }

    v.y = Math.max(v.y + PLAYER.gravity * dt, -40);
    const fallSpeed = v.y;
    const wasGround = this.onGround;

    // integrate + collide
    const target = this.target.copy(this.position).addScaledVector(v, dt);
    const ux = target.x;
    const uy = target.y;
    const uz = target.z;
    const res = this.ctx.world.resolveCapsule(target, PLAYER.radius, PLAYER.height);
    const cx = res.position.x - ux;
    const cy = res.position.y - uy;
    const cz = res.position.z - uz;
    this.position.copy(res.position);
    let onGround = res.onGround;

    // slide along walls: drop the velocity component pointing into the correction
    const ch = Math.hypot(cx, cz);
    if (ch > 1e-5) {
      const nx = cx / ch;
      const nz = cz / ch;
      const vn = v.x * nx + v.z * nz;
      if (vn < 0) {
        v.x -= nx * vn;
        v.z -= nz * vn;
      }
    }
    if (cy < -1e-5 && v.y > 0) v.y = 0; // bonked a ceiling
    if (onGround && v.y < 0) v.y = 0;

    // step down small ledges / ramps instead of hopping off them
    if (!onGround && wasGround && !jumped && v.y <= 0) {
      const gh = this.ctx.world.groundHeight(this.position.x, this.position.z);
      const gap = this.position.y - gh;
      if (gap >= 0 && gap < STEP_DOWN) {
        this.position.y = gh;
        v.y = 0;
        onGround = true;
      }
    }

    if (onGround && !wasGround && fallSpeed < -4) {
      this.landVel -= Math.min(1.6, -fallSpeed * 0.09);
    }

    this.onGround = onGround;
    this.horizontalSpeed = Math.hypot(v.x, v.z);

    // fell out of the world: put back at the start
    if (this.position.y < -30) {
      this.position.copy(this.ctx.world.playerStart);
      v.set(0, 0, 0);
    }
  }

  /** Sets the camera absolutely (fx adds shake afterwards). */
  updateCamera(dt: number, alive: boolean): void {
    const cam = this.ctx.camera;

    // landing dip spring
    const acc = -LAND_SPRING * this.landOffset - LAND_DAMPING * this.landVel;
    this.landVel += acc * dt;
    this.landOffset += this.landVel * dt;

    // head bob
    const hs = this.horizontalSpeed;
    const moving = alive && this.onGround && hs > 0.5;
    const targetAmt = moving ? Math.min(1.25, hs / PLAYER.walkSpeed) : 0;
    this.moveAmount += (targetAmt - this.moveAmount) * damp(10, dt);
    if (moving) this.bobPhase += dt * hs * BOB_PER_METRE;
    const amt = this.moveAmount;
    const bobY = Math.sin(this.bobPhase * 2) * BOB_VERTICAL * amt;
    const bobX = Math.cos(this.bobPhase) * BOB_LATERAL * amt;
    let roll = -Math.cos(this.bobPhase) * 0.004 * amt;

    let eye: number = PLAYER.eyeHeight;
    if (!alive) {
      this.deathT += dt;
      const t = smooth(this.deathT / DEATH_TIME);
      eye = lerp(eye, DEATH_EYE_HEIGHT, t);
      roll += DEATH_ROLL * t;
    } else {
      this.deathT = 0;
    }

    const s = Math.sin(this.yaw);
    const c = Math.cos(this.yaw);
    cam.position.set(
      this.position.x + c * bobX,
      this.position.y + eye + bobY + this.landOffset,
      this.position.z - s * bobX,
    );
    cam.rotation.set(
      clamp(this.pitch + this.recoilPitch, -PITCH_LIMIT, PITCH_LIMIT),
      this.yaw + this.recoilYaw,
      roll,
      'YXZ',
    );

    // sprint FOV
    const fovTarget = CAMERA.fov + (alive && this.sprinting && hs > PLAYER.walkSpeed * 0.9 ? SPRINT_FOV_BONUS : 0);
    const nf = cam.fov + (fovTarget - cam.fov) * damp(8, dt);
    if (Math.abs(nf - cam.fov) > 1e-3) {
      cam.fov = nf;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld(true);
  }
}
