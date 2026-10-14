/**
 * In-game HUD (docs/ART_DIRECTION.md §10): bracket crosshair + corner hit markers, segmented
 * shield/health panel, ammo panel with pips, round plate, hype panel, boss bar with phase
 * notches, damage tags, pickup prompt + cargo-manifest card, LED-ribbon banners, messages,
 * level-up ribbon, muted indicator and a mount point for the standing widgets.
 */
import * as THREE from 'three';
import { INTERMISSION_SECONDS, PLAYER, SUB_WAVES } from '@/core/config';
import type { BossKind, Element, Enemy, GameContext, LootItemState } from '@/core/types';
import { css, leagueStyle, type LeagueStyle } from '@/rendering/style';
import { HYPE_TIER_LABEL, onStanding } from '@/standing/types';
import { createDamageNumbers } from './damageNumbers';
import { esc, h, rarityCss, setScaleX, setText } from './dom';
import { ARCHETYPE_LABEL } from '@/loot/weapons';
import { manifestHtml } from './weaponCard';

export interface HudWidgets {
  update(dt: number): void;
  setVisible(v: boolean): void;
  reset(): void;
}

const BOSS_TITLES: Record<BossKind, string> = { brute: 'The Brute', summoner: 'The Summoner', artillery: 'The Artillery' };
const pad2 = (n: number) => String(Math.max(0, Math.floor(n))).padStart(2, '0');

/** Arena league dressing (world hook), Scrap when absent. */
export function currentLeague(ctx: GameContext): LeagueStyle {
  return (ctx.world as unknown as { leagueStyle?: LeagueStyle } | undefined)?.leagueStyle ?? leagueStyle('scrap');
}

function gauge(parent: HTMLElement, cls: string): { el: HTMLElement; fill: HTMLElement; lag: HTMLElement } {
  const el = h('div', `sb-gauge ${cls}`, parent);
  const lag = h('div', 'lag', el);
  const fill = h('div', 'fill', el);
  h('div', 'mask', el);
  return { el, fill, lag };
}

/** Snap a fraction to whole segments (segments empty one by one). */
const seg = (f: number, n: number) => Math.ceil(Math.max(0, Math.min(1, f)) * n - 1e-6) / n;

export function createHudWidgets(ctx: GameContext, root: HTMLElement): HudWidgets {
  const hud = h('div', 'sb-hud', root);

  // ---- low health edge + damage direction ---------------------------------------------
  const lowEdge = h('div', 'sb-lowedge', hud);
  const dirs: { el: HTMLDivElement; from: THREE.Vector3; t: number }[] = [];
  for (let i = 0; i < 4; i++) {
    const el = h('div', 'sb-dir', hud);
    h('i', '', el);
    dirs.push({ el, from: new THREE.Vector3(), t: 0 });
  }
  let dirCursor = 0;

  const numbers = createDamageNumbers(ctx, hud);

  // ---- crosshair -------------------------------------------------------------------------
  const ch = h('div', 'sb-ch', hud);
  const chT = h('i', 't', ch);
  const chB = h('i', 'b', ch);
  const chL = h('i', 'l', ch);
  const chR = h('i', 'r', ch);
  const hit = h('div', 'sb-hit', hud);
  for (let i = 0; i < 4; i++) h('i', '', hit);
  h('b', '', hit);
  let hitT = 0;
  let killFrame = 0;
  let kick = 0;
  let gap = 8;

  // ---- vitals (bottom-left) ---------------------------------------------------------------
  const vitals = h('div', 'sb-vitals sb-panel', hud);
  h('div', 'sb-tab lowtab', vitals);
  const pts = h('div', 'sb-pts', vitals);
  const ptsText = h('span', '', pts);
  h('span', 'sb-key', pts, 'TAB');
  const r1 = h('div', 'sb-row', vitals);
  h('span', 'sb-lbl', r1, '01 · SHIELD');
  const shieldVal = h('span', 'sb-val', r1);
  const shieldG = gauge(vitals, 'shield');
  const r2 = h('div', 'sb-row', vitals);
  h('span', 'sb-lbl', r2, '02 · HEALTH');
  const healthVal = h('span', 'sb-val', r2);
  const healthG = gauge(vitals, 'health');
  const foot = h('div', 'sb-foot', vitals);
  const lvlEl = h('span', 'sb-val', foot);
  const xpLine = h('div', 'xp', foot);
  const xpFill = h('i', '', xpLine);
  const gren = h('div', 'sb-gren', foot);
  const grenIcons: HTMLElement[] = [];
  for (let i = 0; i < PLAYER.maxGrenades; i++) grenIcons.push(h('i', '', gren));
  const grenNum = h('span', 'sb-lbl', foot);
  let shieldWas = 1;
  let shieldFlash = 0;

  // ---- ammo (bottom-right) ----------------------------------------------------------------
  const ammo = h('div', 'sb-ammo sb-panel', hud);
  h('div', 'sb-tab reltab', ammo);
  const atop = h('div', 'top', ammo);
  const magWrap = h('div', '', atop);
  const magEl = h('span', 'sb-mag', magWrap);
  const resEl = h('span', 'sb-res', magWrap);
  const slotsEl = h('div', 'sb-slots', atop);
  const pips = h('div', 'sb-pips', ammo);
  const wname = h('div', 'sb-wname', ammo);
  const wsub = h('div', 'sb-wsub sb-lbl', ammo);
  let pipsKey = '';
  let wKey = '';
  let slotsKey = '';
  let reload: { t: number; dur: number; weaponId: string } | null = null;

  // ---- round plate (top-left) ---------------------------------------------------------------
  const round = h('div', 'sb-round sb-panel', hud);
  const roundBig = h('div', 'big', round);
  const roundLines = h('div', 'lines', round);
  const roundL1 = h('div', 'sb-lbl', roundLines);
  const roundL2 = h('div', 'sb-val', roundLines);

  // ---- hype (top-right) + standing mount ------------------------------------------------------
  const hype = h('div', 'sb-hype sb-panel', hud);
  const hr = h('div', 'sb-row', hype);
  h('span', 'sb-lbl', hr, 'CROWD');
  const hypeMult = h('span', 'sb-val', hr);
  const hypeG = gauge(hype, '');
  const hypeEv = h('div', 'ev', hype, 'CROWD IS WATCHING');
  const hypeChip = h('span', 'chip sb-hidden', hype);
  let hypeEvT = 0;
  /**
   * Extra standing widgets (src/standing/hud.ts) can mount here. The hype panel itself reads
   * ctx.standing?.hype (value, tier, buff, booing) and its reaction events; without a standing
   * system it falls back to the world's crowd hype.
   */
  h('div', 'sb-standing-mount', hud).dataset.mount = 'standing';

  // ---- muted indicator (last row of the hype panel) ------------------------------------------
  const muteEl = h('div', 'mute sb-hidden', hype);
  muteEl.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M3 9h4l5-4v14l-5-4H3z" fill="currentColor"/>' +
    '<path d="M16 9l6 6M22 9l-6 6" stroke="currentColor" stroke-width="2.6"/></svg><span>SOUND OFF</span><span class="sb-key">M</span>';
  let muteShown = false;

  // ---- boss bar --------------------------------------------------------------------------------
  const boss = h('div', 'sb-boss sb-panel sb-hidden', hud);
  const bhead = h('div', 'head', boss);
  h('span', 'tag', bhead, 'HEADLINER');
  const bossName = h('span', 'bname', bhead);
  const bossPh = h('span', 'ph', bhead);
  const bossShl = h('div', 'shl', boss);
  const bossHp = h('div', 'hp', boss);
  const bossLag = h('div', 'lag', bossHp);
  const bossFill = h('div', 'fill', bossHp);
  const notches = h('div', '', bossHp);
  h('div', 'sb-tab', boss);
  let bossEnemy: Enemy | null = null;
  let bossMaxPhase = 2;
  let bossHideT = 0;
  let notchCount = -1;

  // ---- ribbons / messages -----------------------------------------------------------------------
  const ribbon = h('div', 'sb-ribbon', hud);
  const ribbonQueue: { cls: string; html: string; hold: number; at: number }[] = [];
  let ribbonT = 0;
  let ribbonAt = -1;
  let ribbonPhase: 'idle' | 'hold' | 'out' = 'idle';

  const levelR = h('div', 'sb-level', hud);
  let levelT = 0;

  const msgs = h('div', 'sb-msgs', hud);
  const msgQueue: { text: string; duration: number; style: string; at: number }[] = [];
  const liveMsgs: { el: HTMLElement; t: number }[] = [];

  // ---- prompt + manifest ----------------------------------------------------------------------
  const prompt = h('div', 'sb-prompt sb-hidden', hud);
  const cardSlot = h('div', 'sb-cardslot sb-hidden', hud);
  const card = h('div', 'sb-card', cardSlot);
  let promptItem: LootItemState | null = null;
  let promptKey = '';

  // ======================================================================
  // events
  // ======================================================================
  const isLocal = (id?: string) => !!ctx.player && id === ctx.player.id;
  const killTimes: number[] = [];
  let clock = 0;

  const crowdLine = (text: string, t = 2.5) => {
    hypeEv.textContent = text;
    hypeEvT = t;
  };

  ctx.events.on('damage:dealt', (e) => {
    if (e.playerId !== undefined && !isLocal(e.playerId)) return;
    numbers.spawn(e.enemyId, e.point, e.amount, e.crit, e.element as Element);
    hitT = 0.12;
    hit.classList.toggle('crit', e.crit);
    if (e.killed) {
      hit.classList.add('kill');
      killFrame = 2;
    }
  });

  ctx.events.on('enemy:killed', (e) => {
    if (e.isBoss && bossEnemy && e.enemy.id === bossEnemy.id) bossHideT = 1.2;
    if (e.killerId !== undefined && !isLocal(e.killerId)) return;
    killTimes.push(clock);
    while (killTimes.length && clock - killTimes[0] > 1.6) killTimes.shift();
    if (e.isBoss) crowdLine('HEADLINER DOWN · THE CROWD ERUPTS', 4);
    else if (killTimes.length >= 3) crowdLine(`MULTIKILL ×${killTimes.length}`);
    else if (!(ctx as unknown as { standing?: unknown }).standing) crowdLine('KILL · CROWD APPROVES', 1.4);
  });

  ctx.events.on('weapon:fired', (e) => {
    if (!isLocal(e.playerId)) return;
    kick = Math.min(kick + (e.weapon.archetype === 'sniper' || e.weapon.archetype === 'shotgun' ? 14 : 6), 22);
  });

  ctx.events.on('weapon:reload', (e) => {
    if (!isLocal(e.playerId)) return;
    reload = { t: 0, dur: Math.max(0.05, e.duration), weaponId: e.weapon.id };
  });

  ctx.events.on('player:damaged', (e) => {
    if (!isLocal(e.playerId)) return;
    if (e.from) {
      const d = dirs[dirCursor];
      dirCursor = (dirCursor + 1) % dirs.length;
      d.from.copy(e.from);
      d.t = 1.0;
    }
  });
  ctx.events.on('player:shield', (e) => {
    if (!isLocal(e.playerId)) return;
    if (e.broken) shieldFlash = 0.18;
  });

  ctx.events.on('boss:spawned', (e) => {
    bossEnemy = e.enemy;
    bossMaxPhase = 2;
    bossHideT = 0;
    notchCount = -1;
    const kind = e.enemy.state.kind as BossKind;
    const name = e.name || BOSS_TITLES[kind] || 'Headliner';
    setText(bossName, name.toUpperCase());
    boss.classList.remove('sb-hidden', 'in');
    void boss.offsetWidth;
    boss.classList.add('in');
  });
  ctx.events.on('boss:health', (e) => {
    if (bossEnemy && e.enemyId !== bossEnemy.id) return;
    bossMaxPhase = Math.max(bossMaxPhase, e.phase);
  });

  ctx.events.on('round:intermission', (e) => {
    const ls = currentLeague(ctx);
    queueRibbon('', `
      <div class="sb-tab"></div>
      <div class="band"><div class="big">ROUND ${pad2(e.round)}</div>
        <div class="l1">${ls.name} · ${SUB_WAVES} WAVES · ${pad2(20 + 8 * e.round)} HOSTILES</div>
        <div class="l2">GATES OPEN IN ${e.seconds}</div></div>
      <div class="sb-tab"></div>`, 2.4);
  });
  ctx.events.on('round:boss', (e) => {
    const name = (BOSS_TITLES[e.bossKind] ?? 'The Headliner').toUpperCase();
    queueRibbon('boss', `
      <div class="sb-tab threat"></div>
      <div class="band"><div class="l1">HEADLINER ENTERS · GATE N</div><div class="big">${esc(name)}</div></div>
      <div class="sb-tab threat"></div>`, 2.4);
    crowdLine(`HEADLINER: ${name}`, 4);
  });
  ctx.events.on('round:cleared', (e) => {
    queueRibbon('cleared', `
      <div class="sb-tab bone"></div>
      <div class="band"><div class="big">CLEARED</div><div class="l2">ROUND ${pad2(e.round)} · LOOT THE FLOOR</div></div>
      <div class="sb-tab bone"></div>`, 2.4);
  });
  ctx.events.on('round:subwave', (e) => {
    if (e.subWave > 1) pushMessage(`WAVE ${e.subWave}/${e.total} · GATES CYCLING`, 2.2, 'info');
  });

  ctx.events.on('ui:message', (e) => pushMessage(e.text, e.duration ?? 3, e.style ?? 'info'));

  ctx.events.on('level:up', (e) => {
    if (!isLocal(e.playerId)) return;
    levelR.innerHTML = `<div class="band"><div class="big">LEVEL ${pad2(e.level)} · +1 SKILL POINT</div>
      <div class="burst">${'<i></i>'.repeat(8)}</div></div>`;
    levelR.className = 'sb-level';
    void levelR.offsetWidth;
    levelR.className = 'sb-level in';
    levelT = 2.2;
  });

  ctx.events.on('loot:nearby', (e) => {
    if (!isLocal(e.playerId)) return;
    promptItem = e.item && e.item.weapon ? e.item : null;
    promptKey = '';
  });
  ctx.events.on('loot:dropped', (e) => {
    if (e.item.kind === 'weapon' && e.item.rarity === 'legendary' && (!e.item.ownerId || isLocal(e.item.ownerId))) {
      crowdLine('LEGENDARY DROP · CAMERAS FLASH', 3);
    }
  });

  // standing system (when wired): crowd reactions feed the hype line
  onStanding(ctx.events, 'hype:reaction', (r) => {
    if (!r.label) return;
    const amt = Math.round(r.amount);
    crowdLine(`${amt >= 0 ? '▲' : '▼'} ${r.label.toUpperCase()} · ${amt >= 0 ? '+' : '−'}${Math.abs(amt)}`);
    hypeEv.classList.toggle('neg', amt < 0);
  });
  onStanding(ctx.events, 'hype:gift', (g) => {
    crowdLine(g.kind === 'crate' ? 'CROWD GIFT · CRATE INBOUND' : g.kind === 'buff' ? 'CROWD GIFT · FRENZY' : 'CROWD GIFT · BONUS WAVE', 3);
  });
  onStanding(ctx.events, 'standing:gained', (g) => {
    if (g.reason === 'hype') return;
    crowdLine(`${g.label.toUpperCase()} · +${g.amount} STANDING`, 3);
  });

  ctx.events.on('game:started', () => reset());

  // ======================================================================
  // helpers
  // ======================================================================
  function queueRibbon(cls: string, html: string, hold: number): void {
    ribbonQueue.push({ cls, html, hold, at: clock });
    if (ribbonPhase === 'idle') nextRibbon();
  }
  function nextRibbon(): void {
    const r = ribbonQueue.shift();
    if (!r) {
      ribbonPhase = 'idle';
      return;
    }
    ribbon.innerHTML = r.html;
    ribbon.className = `sb-ribbon ${r.cls}`;
    void ribbon.offsetWidth;
    ribbon.className = `sb-ribbon ${r.cls} in`;
    ribbonT = r.hold;
    ribbonAt = r.at;
    ribbonPhase = 'hold';
  }

  function pushMessage(text: string, duration: number, style: string): void {
    msgQueue.push({ text, duration, style, at: clock });
  }

  function reset(): void {
    bossEnemy = null;
    boss.classList.add('sb-hidden');
    // Keep ribbons/messages raised in this same tick (round 1 intermission, sponsor line):
    // rounds.start() emits them around 'game:started'.
    const fresh = <T extends { at: number }>(q: T[]) => q.splice(0, q.length, ...q.filter((x) => x.at === clock));
    fresh(ribbonQueue);
    if (!(ribbonPhase === 'hold' && ribbonAt === clock)) {
      ribbonPhase = 'idle';
      ribbon.className = 'sb-ribbon';
      if (ribbonQueue.length) nextRibbon();
    }
    numbers.clear();
    reload = null;
    promptItem = null;
    for (const m of liveMsgs) m.el.remove();
    liveMsgs.length = 0;
    fresh(msgQueue);
    for (const d of dirs) d.t = 0;
    killTimes.length = 0;
  }

  // ======================================================================
  // per-frame
  // ======================================================================
  const camFwd = new THREE.Vector3();
  let accentShown = -1;

  function update(dt: number): void {
    clock += dt;
    const ls = currentLeague(ctx);
    if (ls.accent !== accentShown) {
      accentShown = ls.accent;
      root.style.setProperty('--accent', css(ls.accent));
    }
    if (ctx.audio.muted !== muteShown) {
      muteShown = ctx.audio.muted;
      muteEl.classList.toggle('sb-hidden', !muteShown);
    }
    const p = ctx.player;
    const w = p?.activeWeapon ?? null;

    // Crosshair (spread widens the gap)
    kick = Math.max(0, kick - dt * 45);
    const speed = p ? Math.hypot(p.velocity.x, p.velocity.z) : 0;
    const base = w ? 8 + Math.min(w.spread * 300, 32) : 8;
    const target = base + Math.min(speed, PLAYER.sprintSpeed) * 0.9 + kick;
    gap += (target - gap) * Math.min(1, dt * 18);
    const g = Math.round(gap / 2);
    chT.style.transform = `translateY(${-(g + 12)}px)`;
    chB.style.transform = `translateY(${g}px)`;
    chL.style.transform = `translateX(${-(g + 12)}px)`;
    chR.style.transform = `translateX(${g}px)`;
    hitT = Math.max(0, hitT - dt);
    hit.style.opacity = hitT > 0 ? '1' : '0';
    if (killFrame > 0) {
      killFrame--;
      if (killFrame === 0) hit.classList.remove('kill');
    }

    if (p) {
      // Vitals
      const ms = Math.max(1, p.maxShield);
      const mh = Math.max(1, p.maxHealth);
      const sf = p.shield / ms;
      const hf = p.health / mh;
      setScaleX(shieldG.fill, seg(sf, 20));
      setScaleX(shieldG.lag, seg(sf, 20));
      setText(shieldVal, `${Math.ceil(p.shield)} / ${Math.round(ms)}`);
      if (sf < shieldWas - 0.5 && sf <= 0.01) shieldFlash = 0.18;
      shieldWas = sf;
      shieldFlash = Math.max(0, shieldFlash - dt);
      shieldG.el.classList.toggle('flash', shieldFlash > 0);
      setScaleX(healthG.fill, seg(hf, 10));
      setScaleX(healthG.lag, seg(hf, 10));
      setText(healthVal, `${Math.ceil(p.health)} / ${Math.round(mh)}`);
      vitals.classList.toggle('low', hf < 0.25 && p.alive);
      lowEdge.classList.toggle('on', hf < 0.25 && p.alive);
      for (let i = 0; i < grenIcons.length; i++) grenIcons[i].classList.toggle('off', i >= p.grenades);
      setText(grenNum, p.grenades > grenIcons.length ? `×${p.grenades}` : 'GRN');

      // Ammo
      if (w) {
        setText(magEl, `${p.ammo}`);
        setText(resEl, `/ ${p.reserve}`);
        magEl.classList.toggle('low', p.ammo <= Math.ceil(w.magSize * 0.25));
      } else {
        setText(magEl, '--');
        setText(resEl, '');
      }
      if (reload && (!w || w.id !== reload.weaponId)) reload = null;
      let shown = p.ammo;
      if (reload && w) {
        reload.t += dt;
        // pips refill left to right while reloading
        shown = Math.min(w.magSize, Math.floor((reload.t / reload.dur) * w.magSize));
        if (reload.t >= reload.dur) reload = null;
      }
      ammo.classList.toggle('reloading', !!reload);
      const mag = w ? w.magSize : 0;
      const pk = `${mag}|${shown}`;
      if (pk !== pipsKey) {
        pipsKey = pk;
        if (mag > 36) {
          if (!pips.classList.contains('cont')) {
            pips.className = 'sb-pips cont';
            pips.innerHTML = '<div class="fill"></div><div class="mask"></div>';
          }
          setScaleX(pips.firstElementChild as HTMLElement, mag ? shown / mag : 0);
        } else {
          pips.className = 'sb-pips';
          if (pips.childElementCount !== mag || pips.querySelector('.fill')) pips.innerHTML = '<i></i>'.repeat(mag);
          const kids = pips.children;
          for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('off', i >= shown);
        }
      }
      const key = w ? w.id : '';
      if (key !== wKey) {
        wKey = key;
        if (w) {
          wname.innerHTML = `<span class="sb-sq" style="background:${rarityCss(w.rarity)}"></span><span class="nm">${esc(w.name)}</span>`;
          wsub.textContent = [w.rarity, ARCHETYPE_LABEL[w.archetype], w.element !== 'none' ? w.element : '', `ILV ${pad2(w.level)}`].filter(Boolean).join(' · ').toUpperCase();
        } else {
          wname.textContent = 'UNARMED';
          wsub.textContent = '';
        }
      }
      const sk = `${p.activeSlot}|${p.weapons.map((x) => (x ? x.id : '-')).join(',')}`;
      if (sk !== slotsKey) {
        slotsKey = sk;
        slotsEl.innerHTML = 'SLOT ' + p.weapons.map((x, i) => `${i === p.activeSlot ? `<b>${i + 1} ■</b>` : `${i + 1} ${x ? '■' : '□'}`}`).join(' ');
      }

      // Damage direction
      ctx.camera.getWorldDirection(camFwd);
      const fx = camFwd.x;
      const fz = camFwd.z;
      const fl = Math.hypot(fx, fz) || 1;
      for (const d of dirs) {
        if (d.t <= 0) {
          if (d.el.style.opacity !== '0') d.el.style.opacity = '0';
          continue;
        }
        d.t -= dt;
        const tx = d.from.x - ctx.camera.position.x;
        const tz = d.from.z - ctx.camera.position.z;
        const fwdDot = (tx * fx + tz * fz) / fl;
        const rightDot = (tx * -fz + tz * fx) / fl;
        const ang = Math.atan2(rightDot, fwdDot);
        d.el.style.opacity = `${Math.min(1, d.t / 0.3)}`;
        d.el.style.transform = `rotate(${ang.toFixed(3)}rad)`;
      }
    }

    // Round plate
    const rs = ctx.rounds?.state;
    if (rs) {
      setText(roundBig, pad2(Math.max(1, rs.round)));
      setText(roundL1, `ROUND · ${ls.name}`);
      let line = '';
      const left = Math.max(0, rs.killsRequired - rs.kills);
      switch (rs.phase) {
        case 'intermission': line = `GATES OPEN IN ${pad2(Math.ceil(INTERMISSION_SECONDS - rs.phaseTime))}`; break;
        case 'wave': line = `WAVE ${Math.max(1, rs.subWave)}/${SUB_WAVES} · ${pad2(left)} LEFT`; break;
        case 'boss': line = 'HEADLINER · KILL IT'; break;
        case 'cleared': line = 'CLEARED · LOOT UP'; break;
        default: line = 'STAND BY';
      }
      const waitHost = !!ctx.net?.inSession && !ctx.isHost && (rs.phase === 'idle' || rs.phase === 'gameover');
      if (waitHost) line = 'WAITING FOR HOST';
      setText(roundL2, line);
      round.style.visibility = rs.phase === 'idle' && !waitHost ? 'hidden' : 'visible';
    }

    // Hype panel: standing system's crowd favour (0..100) when wired, else the world's crowd hype (0..1)
    const hm = ctx.standing?.hype?.modifiers;
    const hv = THREE.MathUtils.clamp(hm ? hm.value / 100 : (ctx.world as unknown as { hype?: number })?.hype ?? 0, 0, 1);
    setScaleX(hypeG.fill, seg(hv, 10));
    setScaleX(hypeG.lag, seg(hv, 10));
    setText(hypeMult, hm ? `${HYPE_TIER_LABEL[hm.tier]} · ${pad2(Math.round(hm.value))}` : `HYPE ×${1 + Math.floor(hv * 4)}`);
    if (hm && hm.buffRemaining > 0) {
      hypeChip.className = 'chip';
      setText(hypeChip, `FRENZY ×1.3 · ${Math.ceil(hm.buffRemaining)}S`);
    } else if (hm && hm.booing) {
      hypeChip.className = 'chip boo';
      setText(hypeChip, '▼ BOOING · WORSE LOOT');
    } else if (!hypeChip.classList.contains('sb-hidden')) {
      hypeChip.className = 'chip sb-hidden';
    }
    if (hypeEvT > 0) {
      hypeEvT -= dt;
      if (hypeEvT <= 0) {
        hypeEv.classList.remove('neg');
        hypeEv.textContent = hm?.booing ? 'CROWD IS BOOING' : hv > 0.6 ? 'STANDS ON THEIR FEET' : 'CROWD IS WATCHING';
      }
    }

    // Boss bar
    if (bossEnemy) {
      const st = bossEnemy.state;
      const f = st.maxHealth > 0 ? st.health / st.maxHealth : 0;
      setScaleX(bossFill, f);
      setScaleX(bossLag, f);
      bossMaxPhase = Math.max(bossMaxPhase, st.phase);
      const phases = bossMaxPhase + 1;
      if (notchCount !== phases) {
        notchCount = phases;
        notches.innerHTML = Array.from({ length: phases - 1 }, (_, i) => `<i class="notch" style="left:${(((i + 1) / phases) * 100).toFixed(2)}%"></i>`).join('');
      }
      setText(bossPh, `PHASE ${Math.min(phases, st.phase + 1)}/${phases} · ${Math.max(0, Math.ceil(f * 100))} %`);
      const shield = (st as unknown as { shield?: number }).shield ?? 0;
      bossShl.style.transform = `scaleX(${shield > 0 ? 1 : 0})`;
      if (!bossEnemy.alive && bossHideT <= 0) bossHideT = 1.2;
      if (bossHideT > 0) {
        bossHideT -= dt;
        if (bossHideT <= 0) {
          bossEnemy = null;
          boss.classList.add('sb-hidden');
        }
      }
    }

    // XP + skill points
    const prog = ctx.progression;
    if (prog) {
      setText(lvlEl, `LV ${pad2(prog.level)}`);
      setScaleX(xpFill, prog.xpToNext > 0 ? prog.xp / prog.xpToNext : 0);
      pts.style.display = prog.skillPoints > 0 ? '' : 'none';
      setText(ptsText, `${prog.skillPoints} SKILL POINT${prog.skillPoints === 1 ? '' : 'S'}`);
    }

    // Ribbons
    if (ribbonPhase === 'hold') {
      ribbonT -= dt;
      if (ribbonT <= 0) {
        ribbon.className = ribbon.className.replace(' in', ' out');
        ribbonPhase = 'out';
        ribbonT = 0.2;
      }
    } else if (ribbonPhase === 'out') {
      ribbonT -= dt;
      if (ribbonT <= 0) {
        ribbon.className = 'sb-ribbon';
        nextRibbon();
      }
    }
    if (levelT > 0) {
      levelT -= dt;
      if (levelT <= 0) levelR.className = 'sb-level out';
    }

    // Messages (max 3)
    while (msgQueue.length && liveMsgs.length < 3) {
      const m = msgQueue.shift()!;
      const el = h('div', `sb-msg ${m.style}`, msgs, m.text);
      liveMsgs.push({ el, t: m.duration });
    }
    for (let i = liveMsgs.length - 1; i >= 0; i--) {
      const m = liveMsgs[i];
      m.t -= dt;
      if (m.t <= 0.2) m.el.classList.add('out');
      if (m.t <= 0) {
        m.el.remove();
        liveMsgs.splice(i, 1);
      }
    }

    // Pickup prompt + manifest
    if (promptItem && promptItem.weapon && p && p.alive) {
      const nw = promptItem.weapon;
      const k = `${nw.id}|${w ? w.id : ''}`;
      if (k !== promptKey) {
        promptKey = k;
        const swap = p.weapons.every((x) => !!x);
        prompt.innerHTML = `<span class="sb-key">E</span><span class="sb-act">${swap ? 'SWAP' : 'TAKE'}</span><span class="what"><span class="sb-sq" style="background:${rarityCss(nw.rarity)}"></span><span class="nm">${esc(nw.name)}</span></span><span class="rar">${nw.rarity.toUpperCase()}</span>`;
        card.innerHTML = manifestHtml(nw, w, { swap });
      }
      prompt.classList.remove('sb-hidden');
      cardSlot.classList.remove('sb-hidden');
    } else {
      prompt.classList.add('sb-hidden');
      cardSlot.classList.add('sb-hidden');
    }

    numbers.update(dt);
  }

  function setVisible(v: boolean): void {
    hud.classList.toggle('sb-dim', !v);
  }

  return { update, setVisible, reset };
}
