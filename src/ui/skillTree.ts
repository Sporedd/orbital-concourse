/**
 * Skill tree v2 + class picker (docs/SKILL_TREE.md §6, docs/ART_DIRECTION.md §10.3 "Skill tree").
 *
 * Floor plan: the chosen class's three branches and the Pit, two plinth columns per branch, one
 * row per tier, the capstone centred under the class branches. Right column: detail panel and
 * the active ability card. The class picker is an overlay over the start screen or the tree.
 * Sized for 1280×720 (plan 904 px + 32 px gap + 280 px side column).
 */
import type { GameContext, Screen } from '@/core/types';
import {
  BRANCHES, CLASS_LIST, CLASSES, PIT, asClassProgression, describeSkill, rankValue, skillById, visibleSkills,
  type ClassId, type ClassProgression, type SkillDef,
} from '@/progression';
import { esc, h } from './dom';

export interface SkillTreeView {
  /** Re-render the tree panel (cheap enough on every hover/click). */
  render(): void;
  openPicker(): void;
  closePicker(): void;
  /** Show/hide the picker overlay for the screen now shown; auto-opens it on the first run. */
  syncPicker(screen: Screen): void;
  readonly pickerOpen: boolean;
}

export interface SkillTreeCallbacks {
  onClose(): void;
}

// ---- layout (px) ------------------------------------------------------------------------------
const COLW = 104; // plinth column pitch
const BRW = COLW * 2; // branch width
const GAP = 24; // between branches
const ROWH = 112; // tier pitch
const TOP = 48; // first tier row (below the branch heads)
const PL = 56; // plinth size
const CAPPL = 72; // capstone plinth size

const pad2 = (n: number) => String(Math.max(0, Math.floor(n))).padStart(2, '0');
const KIND_LABEL: Record<SkillDef['kind'], string> = { passive: 'PASSIVE', keystone: 'KEYSTONE', capstone: 'CAPSTONE' };

export function createSkillTree(ctx: GameContext, panel: HTMLElement, overlayRoot: HTMLElement, cb: SkillTreeCallbacks): SkillTreeView {
  let selected: string | null = null;
  let respecArmed = false;
  let screen: Screen = 'none';
  let pickOpen = false;
  let pickDismissed = false;
  let pickArmed: ClassId | null = null;

  const prog = (): ClassProgression | null => asClassProgression(ctx.progression);

  // ---- tree ----------------------------------------------------------------------------------
  function nodePos(n: SkillDef, branchIndex: number): { x: number; y: number; size: number } {
    if (n.kind === 'capstone') {
      const mid = (3 * BRW + 2 * GAP) / 2;
      return { x: mid - CAPPL / 2, y: TOP + 3 * ROWH + 8, size: CAPPL };
    }
    const bx = branchIndex * (BRW + GAP);
    return { x: bx + n.col * COLW + (COLW - PL) / 2, y: TOP + (n.tier - 1) * ROWH, size: PL };
  }

  function render(): void {
    const p = prog();
    if (!p) {
      panel.innerHTML = '<div class="sb-skills-head"><div><div class="h">SKILL TREE</div></div></div>';
      return;
    }
    const cls = p.classDef;
    const pts = p.skillPoints;
    const nodes = visibleSkills(p.classId);
    const branchIds = [...(cls ? [0, 1, 2].map((i) => `${cls.id}_${'abc'[i]}`) : []), PIT];
    const branchIndex = (b: string) => (b === PIT ? 3 : b.endsWith('_cap') ? -1 : branchIds.indexOf(b));
    const pos = new Map<string, { x: number; y: number; size: number }>();
    for (const n of nodes) pos.set(n.id, nodePos(n, branchIndex(n.branch)));

    if (!selected || !nodes.some((n) => n.id === selected)) {
      selected = (nodes.find((n) => p.canUpgrade(n.id)) ?? nodes[0])?.id ?? null;
    }

    let svg = '';
    let html = '';
    // branch heads
    for (const b of BRANCHES) {
      const bi = branchIndex(b.id);
      if (bi < 0 || (b.classId !== PIT && b.classId !== p.classId)) continue;
      const x = bi * (BRW + GAP);
      html += `<div class="sb-bhead2" style="left:${x}px;width:${BRW}px"><b>${b.letter} · ${esc(b.name.toUpperCase())}</b><span>${pad2(p.pointsIn(b.id))} PTS</span></div>`;
    }
    if (!cls) {
      html += `<div class="sb-noclass sb-panel" style="left:0;top:${TOP}px;width:${3 * BRW + 2 * GAP}px">
        <div class="sb-lbl">NO CLASS ON FILE</div><div class="t">CHOOSE A CLASS</div>
        <div class="d">Four class trees, one active ability each. The Pit on the right is open to everyone.</div>
        <button type="button" class="sb-btn" data-class="1"><span class="sb-key">LMB</span>CHOOSE CLASS</button></div>`;
    }
    // requirement lines (orthogonal)
    for (const n of nodes) {
      if (!n.requires) continue;
      const a = pos.get(n.requires);
      const b = pos.get(n.id);
      if (!a || !b) continue;
      const ax = a.x + a.size / 2;
      const bx = b.x + b.size / 2;
      const midY = b.y - 6;
      const on = p.rank(n.requires) > 0;
      svg += `<path d="M${ax} ${a.y + a.size} V ${midY} H ${bx} V ${b.y}" stroke="${on ? '#ECEAE4' : '#4A4C50'}" stroke-width="2" fill="none"/>`;
    }
    // capstone: a line from each class branch's last row
    const capNode = nodes.find((n) => n.kind === 'capstone');
    if (capNode) {
      const c = pos.get(capNode.id)!;
      const cy = c.y - 20;
      const cx = c.x + c.size / 2;
      svg += `<path d="M${BRW / 2} ${cy} H ${2 * (BRW + GAP) + BRW / 2} M${cx} ${cy} V ${c.y}" stroke="${p.gateOpen(capNode.id) ? '#ECEAE4' : '#4A4C50'}" stroke-width="2" fill="none" stroke-dasharray="${p.gateOpen(capNode.id) ? '' : '6 4'}"/>`;
    }
    // plinths
    for (const n of nodes) {
      const at = pos.get(n.id)!;
      const r = p.rank(n.id);
      const soon = !n.implemented;
      const reason = p.lockReason(n.id);
      const locked = !soon && r === 0 && reason !== null && reason !== 'NO POINTS';
      const cl = [
        'sb-node', n.kind,
        soon ? 'soon' : '',
        r > 0 ? 'invested' : '',
        locked ? 'locked' : '',
        p.canUpgrade(n.id) ? 'avail' : '',
        n.id === selected ? 'sel' : '',
        soon && p.dev ? 'dev' : '',
      ].filter(Boolean).join(' ');
      const pips = soon
        ? `<div class="rk txt">${p.dev ? 'WIRING' : 'SOON'}</div>`
        : `<div class="rk">${Array.from({ length: n.maxRank }, (_, i) => `<i class="${i < r ? 'on' : ''}"></i>`).join('')}</div>`;
      const state = soon ? 'SOON' : r >= n.maxRank ? 'MAXED' : `RANK ${r}/${n.maxRank}`;
      const label = n.kind === 'capstone'
        ? `<div class="nm cap"><b>${esc(n.name)}</b><span>CAPSTONE · ${state}</span></div>`
        : `<div class="nm"><b>${esc(n.name)}</b></div>`;
      html += `<div class="${cl}" data-skill="${esc(n.id)}" style="left:${at.x}px;top:${at.y}px" role="button" aria-label="${esc(n.name)} ${state}">
        <span class="code">${n.code}</span>${pips}${label}</div>`;
    }

    const planW = 4 * BRW + 3 * GAP;
    const planH = TOP + 3 * ROWH + 8 + CAPPL;
    panel.innerHTML = `
      <div class="sb-skills-head">
        <div><div class="sb-lbl">QUARTERS · TRAINING FLOOR</div>
          <div class="h">${cls ? `${esc(cls.name.toUpperCase())} · ` : ''}SKILL TREE</div>
          <div class="sb-lbl" style="margin-top:8px">LV ${pad2(p.level)}${cls ? ` · ${esc(cls.tag)} · ${pad2(p.classPoints())}/40 CLASS · ${pad2(p.pointsIn(PIT))}/10 PIT` : ''}</div></div>
        <div class="sb-chip">${pad2(pts)} POINT${pts === 1 ? '' : 'S'}</div>
      </div>
      <div class="sb-plan sb-plan2" style="width:${planW}px;height:${planH}px"><svg width="${planW}" height="${planH}">${svg}</svg>${html}</div>
      <div class="sb-tree-side">${detailHtml(p)}${activeHtml(p)}</div>
      <div class="sb-skills-foot"><span class="sb-key">TAB</span><span class="sb-act">BACK</span>
        <button type="button" class="sb-btn" data-class="1">CLASS${cls ? `: ${esc(cls.name.toUpperCase())}` : ''}</button>
        <button type="button" class="sb-btn${respecArmed ? ' armed' : ''}" data-respec="1">${respecArmed ? 'CONFIRM RESPEC · FREE' : 'RESPEC'}</button></div>`;
  }

  function detailHtml(p: ClassProgression): string {
    const n = selected ? skillById(selected) : undefined;
    if (!n) return '';
    const r = p.rank(n.id);
    const reason = p.lockReason(n.id);
    const can = p.canUpgrade(n.id);
    const branch = BRANCHES.find((b) => b.id === n.branch)?.name ?? (n.kind === 'capstone' ? 'Capstone' : '');
    const total = n.perRank !== undefined
      ? `<span>${r > 0 ? rankValue(n, r) : '—'} → ${r >= n.maxRank ? 'MAX' : rankValue(n, r + 1)}</span>`
      : `<span>${r >= n.maxRank ? 'OWNED' : 'NOT OWNED'}</span>`;
    const wiring = !n.implemented
      ? `<div class="sb-soon">${p.dev ? `NEEDS WIRING · ${esc(n.hook)}` : 'SOON · NOT IN THE ARENA YET'}</div>`
      : '';
    const status = can ? 'COSTS ONE POINT' : r >= n.maxRank ? 'MAXED' : reason ?? '';
    return `<div class="sb-detail2 sb-panel">
      <div class="sb-lbl">${n.code} · ${esc(branch.toUpperCase())} · ${KIND_LABEL[n.kind]}</div>
      <div class="dn">${esc(n.name)}</div>
      <div class="df">${esc(n.flavour)}</div>
      <div class="dd">${esc(describeSkill(n))}</div>
      ${wiring}
      <div class="dv"><span>RANK ${r}/${n.maxRank}</span>${total}</div>
      <div class="acts"><button type="button" class="sb-btn" data-invest="${esc(n.id)}" ${can ? '' : 'disabled'}><span class="sb-key">LMB</span>INVEST</button>
      <span class="sb-lbl st">${esc(status)}</span></div>
    </div>`;
  }

  function activeHtml(p: ClassProgression): string {
    const a = p.activeAbility;
    if (!a) return '';
    const def = a.def;
    const keyLive = true; // docs §5.1 player:activeKey — bound to Q (src/player)
    const state = !a.unlocked ? 'LOCKED' : a.active ? `ACTIVE ${Math.ceil(a.activeLeft)} S` : a.ready ? 'READY' : `CD ${Math.ceil(a.cooldownLeft)} S`;
    const note = !a.unlocked
      ? 'UNLOCKS WITH YOUR FIRST KEYSTONE'
      : !keyLive ? (p.dev ? `NEEDS WIRING · player:activeKey${def.liveEffect ? '' : ` + ${def.hook}`}` : 'KEY BINDING ARRIVES SOON') : '';
    return `<div class="sb-active sb-panel${a.unlocked ? '' : ' locked'}">
      <div class="sb-tab"></div>
      <div class="hd"><span class="sb-lbl">ACTIVE · <span class="sb-key">${esc(def.key)}</span></span><span class="sb-lbl st">${state}</span></div>
      <div class="dn">${esc(def.name)}</div>
      <div class="dd">${esc(def.description)}</div>
      <div class="dv"><span>COOLDOWN ${Math.round(a.cooldown)} S</span>${def.duration > 0 ? `<span>${def.duration} S</span>` : ''}</div>
      ${note ? `<div class="sb-soon">${esc(note)}</div>` : ''}
    </div>`;
  }

  panel.addEventListener('mouseover', (e) => {
    const n = (e.target as HTMLElement).closest('.sb-node') as HTMLElement | null;
    if (!n || !n.dataset.skill || n.dataset.skill === selected) return;
    selected = n.dataset.skill;
    render();
  });
  panel.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const node = t.closest('.sb-node') as HTMLElement | null;
    const btn = t.closest('button') as HTMLButtonElement | null;
    const p = prog();
    if (!p) return;
    if (!btn?.dataset.respec) respecArmed = false;
    if (node?.dataset.skill) {
      selected = node.dataset.skill;
      if (p.upgrade(selected)) ctx.audio.play('skill_up');
    } else if (btn && !btn.disabled) {
      if (btn.dataset.invest) {
        if (p.upgrade(btn.dataset.invest)) ctx.audio.play('skill_up');
      } else if (btn.dataset.respec) {
        if (respecArmed) {
          p.respec();
          respecArmed = false;
        } else respecArmed = true;
        ctx.audio.play('ui_click');
      } else if (btn.dataset.class) {
        openPicker();
        return;
      }
    } else if (!btn && !node && !t.closest('.sb-tree-side') && !t.closest('.sb-skills-head') && !t.closest('.sb-noclass')) {
      cb.onClose();
      return;
    }
    render();
  });

  // ---- class picker ------------------------------------------------------------------------------
  const pick = h('div', 'sb-classpick sb-hidden', overlayRoot);
  pick.addEventListener('click', (e) => {
    e.stopPropagation();
    const t = e.target as HTMLElement;
    const btn = t.closest('button') as HTMLButtonElement | null;
    const card = t.closest('.sb-ccard') as HTMLElement | null;
    const p = prog();
    if (!p) return;
    if (btn?.dataset.close) {
      pickDismissed = true;
      closePicker();
      ctx.audio.play('ui_click');
      return;
    }
    const id = (card?.dataset.cls ?? '') as ClassId;
    if (!CLASSES[id]) return;
    if (id === p.classId) {
      closePicker();
      return;
    }
    // changing an existing class refunds its tree: ask once
    if (p.classId && p.classPoints() > 0 && pickArmed !== id) {
      pickArmed = id;
      renderPicker();
      ctx.audio.play('ui_click');
      return;
    }
    p.setClass(id);
    pickArmed = null;
    ctx.audio.play('skill_up');
    closePicker();
    render();
  });

  function renderPicker(): void {
    const p = prog();
    if (!p) return;
    const cards = CLASS_LIST.map((c, i) => {
      const cur = c.id === p.classId;
      const armed = pickArmed === c.id;
      const cta = cur ? 'CURRENT CLASS' : armed ? `REFUNDS ${p.classPoints()} POINTS · CLICK TO CONFIRM` : p.classId ? 'SWITCH' : 'PICK';
      return `<div class="sb-ccard${cur ? ' cur' : ''}${armed ? ' armed' : ''}" data-cls="${c.id}" role="button" aria-label="${esc(c.name)}">
        <div class="band"><span>${pad2(i + 1)} · ${esc(c.tag)}</span><span>${cur ? 'ON FILE' : ''}</span></div>
        <div class="body">
          <div class="cn">${esc(c.name)}</div>
          <div class="cb">${esc(c.blurb)}</div>
          <table>
            ${c.identityText.map((t) => `<tr><td class="k">IDENTITY</td><td>${esc(t)}</td></tr>`).join('')}
            <tr><td class="k">STARTER</td><td>${esc(c.starterArchetype.toUpperCase())}</td></tr>
            <tr><td class="k">TREE</td><td>${c.branches.map((b) => esc(b.toUpperCase())).join(' · ')}</td></tr>
          </table>
          <div class="act"><div class="sb-tab thin"></div><div class="ab">
            <b>${esc(c.active.name)} <span>[${esc(c.active.key)}] · ${c.active.cooldown} S</span></b>${esc(c.active.description)}</div></div>
          <div class="cta"><span class="sb-key">LMB</span>${cta}</div>
        </div></div>`;
    }).join('');
    pick.innerHTML = `<div class="sb-cp-in">
      <div class="sb-cp-head"><div><div class="sb-lbl">QUARTERS · REGISTRATION DESK</div><div class="h">CHOOSE YOUR CLASS</div>
        <div class="sb-lbl" style="margin-top:8px">ONE PER PROFILE · SWITCH ANY TIME · SWITCHING REFUNDS THE CLASS TREE, THE PIT IS KEPT</div></div>
        <button type="button" class="sb-btn" data-close="1">${p.classId ? 'BACK' : 'DECIDE LATER'}</button></div>
      <div class="sb-cp-cards">${cards}</div></div>`;
  }

  function applyPicker(): void {
    const visible = pickOpen && (screen === 'start' || screen === 'skills');
    pick.classList.toggle('sb-hidden', !visible);
  }
  function openPicker(): void {
    pickOpen = true;
    pickArmed = null;
    renderPicker();
    applyPicker();
    ctx.audio.play('ui_open');
  }
  function closePicker(): void {
    pickOpen = false;
    pickArmed = null;
    applyPicker();
  }
  function syncPicker(s: Screen): void {
    screen = s;
    respecArmed = false;
    const p = prog();
    if (s === 'start' && p && !p.classId && !pickDismissed && !pickOpen) {
      pickOpen = true;
      renderPicker();
    }
    if (s !== 'start' && s !== 'skills') pickOpen = false;
    applyPicker();
  }

  return {
    render,
    openPicker,
    closePicker,
    syncPicker,
    get pickerOpen() { return pickOpen; },
  };
}
