/**
 * Mobile stylesheet: the touch controls and the phone-size overrides for every HUD widget and
 * screen. Every selector is scoped under `html.mobile` (src/mobile/index.ts sets the class), and
 * the sheet is only injected by the mobile layer, so the desktop never sees a rule of it.
 * Targets: landscape 844×390 (iPhone 12–15) up to 932×430, with notch insets
 * (env(safe-area-inset-*)). Same floor as the desktop UI: no text under 12 px; every touch target
 * at least 44 px.
 */

export const MOBILE_STYLE_ID = 'sbm-styles';

export function injectMobileStyles(): void {
  if (document.getElementById(MOBILE_STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = MOBILE_STYLE_ID;
  st.textContent = MOBILE_CSS;
  document.head.appendChild(st);
}

const M = 'html.mobile';

export const MOBILE_CSS = /* css */ `
${M} {
  --sat: env(safe-area-inset-top, 0px); --sar: env(safe-area-inset-right, 0px);
  --sab: env(safe-area-inset-bottom, 0px); --sal: env(safe-area-inset-left, 0px);
  --mbone: #ECEAE4; --mpanel: rgba(20,21,22,.42); --maccent: #FF5F1F;
  touch-action: manipulation; overscroll-behavior: none; -webkit-tap-highlight-color: transparent;
  -webkit-text-size-adjust: 100%; text-size-adjust: 100%;
}
${M} body { overscroll-behavior: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
${M} input, ${M} textarea { -webkit-user-select: text; user-select: text; font-size: 16px; }
${M} .sbm-desk { display: none !important; }

/* ---- touch layer (under #ui): stick + look ------------------------------------------------ */
${M} .sbm-touch { position: fixed; inset: 0; display: none; touch-action: none; -webkit-user-select: none; user-select: none; }
${M}.sbm-play .sbm-touch { display: block; }
${M} .sbm-stick { position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; opacity: .3;
  transform: translate(calc(var(--sal) + 120px), calc(100dvh - var(--sab) - 112px)); }
${M} .sbm-stick.live { opacity: 1; }
${M} .sbm-stick > * { position: absolute; left: 0; top: 0; border-radius: 50%; }
${M} .sbm-stick .ring { width: calc(var(--sr) * 2 + 28px); height: calc(var(--sr) * 2 + 28px); transform: translate(-50%, -50%);
  border: 2px dashed rgba(255,95,31,.45); }
${M} .sbm-stick .base { width: calc(var(--r) * 2); height: calc(var(--r) * 2); transform: translate(-50%, -50%);
  background: rgba(20,21,22,.35); border: 2px solid rgba(236,234,228,.5); }
${M} .sbm-stick .knob { width: 52px; height: 52px; transform: translate(-50%, -50%); background: rgba(236,234,228,.6); }
${M} .sbm-stick.sprint .ring { border-style: solid; border-color: var(--maccent); background: rgba(255,95,31,.14); }
${M} .sbm-stick.sprint .knob { background: var(--maccent); }

/* ---- controls layer (over #ui) -------------------------------------------------------------- */
${M} .sbm-controls { position: fixed; inset: 0; z-index: 30; pointer-events: none; display: none;
  font-family: 'Martian Mono', Consolas, monospace; }
${M}.sbm-play .sbm-controls { display: block; }
${M} .sbm-btn { all: unset; box-sizing: border-box; position: absolute; pointer-events: auto; touch-action: none;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  min-width: 44px; min-height: 44px; background: var(--mpanel); border: 2px solid rgba(236,234,228,.45);
  color: var(--mbone); font: 700 12px/1 'Martian Mono', Consolas, monospace; letter-spacing: .08em; text-transform: uppercase;
  -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; cursor: pointer; }
${M} .sbm-btn.on { background: rgba(236,234,228,.88); color: #141516; border-color: var(--mbone); }
${M} .sbm-btn.sbm-off { display: none; }

/* fire cluster: (right, bottom) of each button from the bottom-right safe corner */
${M} .sbm-cluster { position: absolute; right: calc(var(--sar) + 14px); bottom: calc(var(--sab) + 12px); width: 0; height: 0; }
${M} .sbm-cluster .round { width: 54px; height: 54px; border-radius: 50%; letter-spacing: 0; }
${M} .sbm-b-fire { right: 0; bottom: 14px; width: 96px; height: 96px; border-radius: 50%; border: 3px solid var(--maccent);
  background: rgba(255,95,31,.18); font-size: 14px; }
${M} .sbm-b-fire .auto { display: none; font-size: 12px; font-weight: 400; color: var(--maccent); letter-spacing: .12em; }
${M} .sbm-b-fire.autoon .auto { display: block; }
${M} .sbm-b-fire.firing { background: rgba(255,95,31,.5); }
${M} .sbm-b-fire.firing .auto { color: var(--mbone); }
${M} .sbm-b-fire.on { background: var(--maccent); color: #141516; border-color: var(--maccent); }
${M} .sbm-b-fire.on .auto { color: #141516; }
${M} .sbm-b-jump { right: 112px; bottom: 0; width: 64px !important; height: 64px !important; }
${M} .sbm-b-ads { right: 102px; bottom: 74px; width: 58px !important; height: 58px !important; }
${M} .sbm-b-reload { right: 20px; bottom: 116px; }
${M} .sbm-b-melee { right: 188px; bottom: 30px; }
${M} .sbm-b-grenade { right: 172px; bottom: 104px; }
${M} .sbm-b-skill { right: 252px; bottom: 86px; }
${M} .sbm-b-skill.ready { border-color: var(--mbone); background: rgba(236,234,228,.28); }
${M} .sbm-b-skill.live { background: var(--maccent); color: #141516; border-color: var(--maccent); }
${M} .sbm-b-swap { right: 254px; bottom: 14px; }
${M} .sbm-b-grenade::after { content: '×' attr(data-count); font-weight: 400; color: #C9C7C0; }
${M} .sbm-b-grenade[data-count="0"] { opacity: .5; }
${M} .sbm-b-skills.badge::after { content: ''; position: absolute; right: -4px; top: -4px; width: 12px; height: 12px; background: var(--maccent); }

/* top bar (left) and contextual buttons (centre, above the vitals) */
${M} .sbm-top { position: absolute; left: calc(var(--sal) + 8px); top: calc(var(--sat) + 8px); display: flex; gap: 6px; pointer-events: none; }
${M} .sbm-top .sbm-btn { position: relative; height: 44px; padding: 0 12px; border-width: 0; border-top: 2px solid var(--mbone); background: rgba(20,21,22,.6); }
${M} .sbm-top .sbm-btn.on { background: var(--mbone); }
${M} .sbm-b-pause, ${M} .sbm-b-help { width: 44px; padding: 0 !important; font-size: 16px !important; }
${M} .sbm-ctx { position: absolute; left: 50%; bottom: calc(var(--sab) + 92px); transform: translateX(-50%); display: flex; gap: 8px; pointer-events: none; }
${M} .sbm-ctx .sbm-btn { position: static; height: 48px; padding: 0 18px; border: 0; border-top: 2px solid var(--maccent); background: rgba(20,21,22,.82); font-size: 13px; }
${M} .sbm-ctx .sbm-btn.on { background: var(--maccent); color: #141516; }

/* ---- portrait blocker ----------------------------------------------------------------------- */
${M} .sbm-rotate { display: none; }
@media (orientation: portrait) {
  ${M} .sbm-rotate { display: flex; position: fixed; inset: 0; z-index: 1000; align-items: center; justify-content: center;
    background: #0c0d0e; color: var(--mbone); font-family: 'Martian Mono', Consolas, monospace; text-align: center; padding: 24px; }
  ${M} .sbm-rotate .ph { width: 56px; height: 96px; margin: 0 auto 24px; border: 3px solid var(--mbone); position: relative; animation: sbm-turn 2s ease-in-out infinite; }
  ${M} .sbm-rotate .ph i { position: absolute; left: 50%; bottom: 6px; width: 12px; height: 4px; margin-left: -6px; background: var(--maccent); }
  ${M} .sbm-rotate .t { font-size: 16px; font-weight: 700; letter-spacing: .14em; }
  ${M} .sbm-rotate .s { font-size: 12px; letter-spacing: .12em; color: #9A9890; margin-top: 8px; }
}
@keyframes sbm-turn { 0%, 30% { transform: rotate(0deg); } 60%, 100% { transform: rotate(-90deg); } }
@media (prefers-reduced-motion: reduce) { ${M} .sbm-rotate .ph { animation: none; transform: rotate(-90deg); } }

/* ---- HUD: compact, out of the thumb zones ----------------------------------------------------- */
${M} .sb-round { left: 50%; top: calc(var(--sat) + 6px); transform: translateX(-50%); min-width: 0; gap: 10px; padding: 4px 12px; }
${M} .sb-round .big { font-size: 30px; min-width: 0; }
${M} .sb-round .lines { gap: 2px; }
${M} .sb-hype { right: calc(var(--sar) + 8px); top: calc(var(--sat) + 8px); width: 184px; padding: 6px 10px; }
${M} .sb-hype .sb-row { white-space: nowrap; gap: 8px; }
${M} .sb-hype .sb-row .sb-val { font-size: 13px; overflow: hidden; text-overflow: ellipsis; }
${M} .sb-hype .sb-gauge { margin: 4px 0; height: 8px; }
${M} .sb-hype .ev { min-height: 0; }
${M} .sb-hype .chip { margin-top: 4px; }
${M} .sb-hype .mute { margin: 4px -10px -6px; padding: 2px 10px; }
${M} .sb-hype .mute .sb-key { display: none; }
${M} .sb-standing-mount { display: none; }
${M} .sb-ammo { right: calc(var(--sar) + 8px); top: calc(var(--sat) + 96px); bottom: auto; width: 184px; padding: 6px 10px; }
${M} .sb-ammo .top { align-items: baseline; }
${M} .sb-mag { font-size: 28px; }
${M} .sb-res { font-size: 14px; margin-left: 4px; }
${M} .sb-slots { display: none; }
${M} .sb-pips { height: 6px; margin: 4px 0; }
${M} .sb-wname { font-size: 12px; }
${M} .sb-wsub { display: none; }
${M} .sb-scrip { margin-top: 4px; padding-top: 2px; }
${M} .sb-vitals { left: calc(50% - 30px); bottom: calc(var(--sab) + 6px); transform: translateX(-50%); width: 228px; padding: 6px 10px; }
${M} .sb-vitals .sb-row { margin-bottom: 4px; gap: 6px; white-space: nowrap; }
${M} .sb-vitals .sb-row .sb-lbl { letter-spacing: .04em; }
${M} .sb-vitals .sb-row + .sb-gauge { margin-bottom: 6px; }
${M} .sb-gauge.health { height: 10px; }
${M} .sb-gauge.shield { height: 8px; }
${M} .sb-vitals .sb-row + .sb-gauge.health { margin-bottom: 0; }
${M} .sb-foot, ${M} .sb-pts, ${M} .sb-qchip { display: none !important; }
${M} .sb-boss { top: calc(var(--sat) + 56px); width: min(440px, calc(100vw - 2 * 220px)); min-width: 280px; }
${M} .sb-boss .bname { font-size: 14px; }
${M} .sb-boss .hp { height: 10px; }
${M} .sb-boss .sb-tab { margin-top: 4px; height: 5px; }
${M} .sb-pit { top: calc(var(--sat) + 56px); width: min(520px, calc(100vw - 2 * 200px)); min-width: 320px; }
${M} .sb-pit .band { padding: 8px 12px; }
${M} .sb-pit .big { font-size: 24px; }
${M} .sb-pit .acts { margin-top: 8px; }
${M} .sb-pit button { min-height: 44px; padding: 4px 14px; }
${M} .sb-pit button .sb-key { display: none; }
${M} .sb-prompt { top: auto; bottom: calc(var(--sab) + 150px); max-width: min(560px, calc(100vw - 2 * 200px)); padding: 6px 10px; }
${M} .sb-prompt > .sb-key, ${M} .sb-prompt .sb-key.salv { display: none; }
${M} .sb-prompt .sb-act { margin-left: 0; }
${M} .sb-cardslot { right: auto; left: calc(var(--sal) + 8px); top: calc(var(--sat) + 60px); bottom: auto; max-height: calc(100dvh - var(--sat) - var(--sab) - 200px); }
${M} .sb-card { width: 248px; }
${M} .sb-card .cname { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
${M} .sb-card .body { padding: 6px 10px; }
${M} .sb-card .csub { margin: 4px 0; }
${M} .sb-card td { padding: 1px 0; }
${M} .sb-card .perk .pb { padding: 4px 10px; line-height: 1.35; }
${M} .sb-card .foot, ${M} .sb-barcode, ${M} .sb-serial { display: none; }
${M} .sb-level { width: min(420px, 56vw); margin-left: 0; transform: translateX(-50%); bottom: calc(var(--sab) + 150px); }
${M} .sb-level .big { font-size: 24px; }
${M} .sb-level .band { padding: 8px 12px; }
${M} .sb-msgs { top: calc(var(--sat) + 116px); bottom: auto; flex-direction: column; width: min(460px, calc(100vw - 2 * 210px)); min-width: 260px; }
${M} .sb-ribbon { top: 46%; }
${M} .sb-ribbon .big { font-size: 44px; }
${M} .sb-ribbon.boss .big { font-size: 26px; }
${M} .sb-ribbon .band { padding: 10px 12px; }
${M} .sb-ribbon .l1, ${M} .sb-ribbon .l2 { font-size: 12px; margin-top: 4px; }
${M} .sb-dir i { top: -110px; }
${M} .sb-scope { --r: min(44vh, 40vw); }
${M} .sb-scope .read { display: none; }

/* ---- shared screen parts ------------------------------------------------------------------------ */
${M} .sb-screen { -webkit-tap-highlight-color: transparent; }
${M} .sb-gateart, ${M} .sb-helphint { display: none !important; }
${M} .sb-menu button { min-height: 44px; padding: 6px 14px; gap: 12px; }
${M} .sb-btn { min-height: 44px; padding: 4px 14px; }
${M} .sb-key { min-width: 24px; }
${M} .sb-step { width: 44px; height: 44px; font-size: 18px; }
${M} .sb-range { height: 44px; }
${M} .sb-range::-webkit-slider-thumb { width: 24px; height: 36px; margin-top: -14px; }
${M} .sb-toggle { min-height: 44px; }
${M} .sb-toggle span { display: flex; align-items: center; padding: 0 14px; }
${M} .sb-set-row { padding: 6px 0; }
${M} .sb-panel { padding: 10px 12px; }
${M} .sb-band .t { font-size: 34px; }
${M} .sb-band.threat .t { font-size: 26px; }
${M} .sb-band .inner { padding: 8px 12px 10px; }
${M} .sb-band .s { margin-top: 4px; }
${M} .sb-center { justify-content: flex-start; gap: 10px; overflow-y: auto; -webkit-overflow-scrolling: touch;
  padding: calc(var(--sat) + 10px) calc(var(--sar) + 16px) calc(var(--sab) + 16px) calc(var(--sal) + 16px); }
${M} .sb-center > * { flex: none; }

/* start: title + CTA on top, menu left, side panel right, plaque under the menu; scrolls */
${M} .sb-start { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: auto auto auto; gap: 12px 16px; align-content: start;
  overflow-y: auto; -webkit-overflow-scrolling: touch;
  padding: calc(var(--sat) + 12px) calc(var(--sar) + 16px) calc(var(--sab) + 16px) calc(var(--sal) + 16px); }
${M} .sb-start .tb { grid-column: 1; grid-row: 1; align-self: center; }
${M} .sb-title { font-size: 28px; }
${M} .sb-tagline { margin-top: 6px; }
${M} .sb-start .sb-cta { grid-column: 2; grid-row: 1; align-self: center; justify-self: end; padding: 14px 16px; }
${M} .sb-start .sb-cta:not(.wait) { font-size: 0; }
${M} .sb-start .sb-cta:not(.wait)::before { content: 'TAP TO ENTER'; font-size: 14px; }
${M} .sb-start .sb-cta:not(.wait)::after { font-size: 14px; }
${M} .sb-start .sb-menu { grid-column: 1; grid-row: 2; width: auto; align-self: start; }
${M} .sb-start .sb-menu button { min-height: 44px; padding: 6px 14px; }
${M} .sb-start .side { grid-column: 2; grid-row: 2 / 4; align-self: start; max-height: none; overflow: visible; }
${M} .sb-start .sb-plaque { grid-column: 1; grid-row: 3; width: 100%; }
${M} .sb-controls .grid { display: none; }
${M} .sbm-ctrls { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px 12px; align-items: center; }
${M} .sbm-ctrls .k { justify-self: start; padding: 4px 8px; border: 2px solid var(--bone); font-size: 12px; font-weight: 700; letter-spacing: .08em; white-space: nowrap; }
${M} .sbm-ctrls .d { font-size: 12px; letter-spacing: .06em; text-transform: uppercase; line-height: 1.4; }
${M} .sb-side-panel .hd { flex-wrap: wrap; gap: 4px 12px; }

/* pause: menu + settings side by side, the band compact */
${M} .sb-pause-row { width: 100%; max-width: 860px; gap: 12px; align-items: flex-start; }
${M} .sb-pause-row .sb-menu { flex: 1 1 0; width: auto; min-width: 0; }
${M} .sb-pause-row .sb-settings { flex: 1 1 0; width: auto; min-width: 0; }

/* game over */
${M} .sb-over-row { width: 100%; max-width: 860px; gap: 12px; flex-wrap: wrap; }
${M} .sb-recap { width: auto; flex: 1 1 320px; min-width: 0; }
${M} .sb-recap td { padding: 3px 0; }
${M} .sb-recap tr.big td:last-child { font-size: 22px; }
${M} .sb-over-side { width: auto; flex: 1 1 280px; min-width: 0; }
${M} .sb-over-acts { flex-wrap: wrap; justify-content: center; }
${M} .sb-over-acts .sb-menu { flex-wrap: wrap; }

/* skill tree: header, then the floor plan (scrolls both ways) beside the detail column */
${M} .sb-skills { display: grid; grid-template-columns: minmax(0, 1fr) 248px; grid-template-rows: auto minmax(0, 1fr) auto; gap: 8px 12px;
  padding: calc(var(--sat) + 8px) calc(var(--sar) + 12px) calc(var(--sab) + 8px) calc(var(--sal) + 12px); }
${M} .sb-skills-head { grid-column: 1 / -1; grid-row: 1; align-items: center; gap: 12px; }
${M} .sb-skills-head .h { font-size: 20px; margin-top: 2px; }
${M} .sb-skills-head .sb-lbl[style] { margin-top: 2px !important; }
${M} .sb-plan, ${M} .sb-plan.sb-plan2 { grid-column: 1; grid-row: 2; position: relative; left: auto; top: auto;
  width: auto !important; height: auto !important; min-height: 0; overflow: auto; -webkit-overflow-scrolling: touch;
  touch-action: pan-x pan-y; background: rgba(28,30,33,.5); }
${M} .sb-plan svg { left: 8px; top: 8px; }
${M} .sb-plan .sb-node, ${M} .sb-plan .sb-bhead2, ${M} .sb-plan .sb-noclass { margin: 8px 0 0 8px; }
${M} .sb-tree-side { grid-column: 2; grid-row: 2; position: static; width: auto; min-height: 0; overflow-y: auto; gap: 8px; }
${M} .sb-skills-foot { grid-column: 1 / -1; grid-row: 3; position: static; gap: 12px; }
${M} .sb-skills-foot .sb-key { display: none; }
${M} .sb-skills-foot .sb-act { display: inline-flex; align-items: center; min-height: 44px; padding: 0 16px; background: var(--panel); border-top: 2px solid var(--bone); cursor: pointer; }
${M} .sb-skills-foot .sb-act::before { content: '◂ '; }
${M} .sb-detail2 .dn, ${M} .sb-active .dn { font-size: 14px; }
${M} .sb-detail2 .acts .sb-key, ${M} .sb-ccard .cta .sb-key { display: none; }

/* class picker: two cards per row, scrolls */
${M} .sb-cp-in { padding: calc(var(--sat) + 10px) calc(var(--sar) + 16px) calc(var(--sab) + 16px) calc(var(--sal) + 16px); gap: 12px; }
${M} .sb-cp-head .h { font-size: 22px; }
${M} .sb-cp-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
${M} .sb-ccard .cn { font-size: 18px; }
${M} .sb-ccard .cta { min-height: 44px; }

/* help: narrower topic list, no keyboard legend */
${M} .sbh-wrap { padding: calc(var(--sat) + 8px) calc(var(--sar) + 12px) calc(var(--sab) + 8px) calc(var(--sal) + 12px); gap: 8px; }
${M} .sbh-hrow { padding: 6px 12px; }
${M} .sbh-hk { display: none; }
${M} .sbh-title { font-size: 22px; margin-bottom: 2px; }
${M} .sbh-body { grid-template-columns: 196px minmax(0, 1fr); gap: 8px; }
${M} .sbh-list.sb-menu button { min-height: 44px; padding: 4px 10px 4px 12px; gap: 8px; letter-spacing: .04em; }
${M} .sbh-page { padding: 10px 14px 16px; -webkit-overflow-scrolling: touch; }
${M} .sbh-pt { font-size: 20px; }
${M} .sbh-ph { padding-bottom: 8px; margin-bottom: 10px; }
${M} .sbh-keys { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px 16px; }
${M} .sbh-foot .sb-btn .sb-key { display: none; }
${M} .sbh-foot .sbh-src { display: none; }

/* loadout + shop: two columns that scroll, the third column underneath, CLOSE pinned */
${M} .sbg-inv { padding: calc(var(--sat) + 8px) calc(var(--sar) + 12px) 0 calc(var(--sal) + 12px); gap: 8px 10px;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) !important; grid-template-rows: none; grid-auto-rows: auto;
  align-content: start; overflow-y: auto; -webkit-overflow-scrolling: touch; }
${M} .sbg-inv > .sbg-col:nth-child(4) { grid-column: 1 / -1; }
/* loadout: backpack first (full width), then upgrade bay / equipped beside the mannequin */
${M} .sbg-inv:not(.sbg-shop) > .sbg-col:nth-child(4) { grid-row: 2; }
${M} .sbg-inv:not(.sbg-shop) > .sbg-col:nth-child(3) { grid-column: 1; grid-row: 3; }
${M} .sbg-inv:not(.sbg-shop) > .sbg-col:nth-child(2) { grid-column: 2; grid-row: 3; }
${M} .sbg-head .h { font-size: 22px; }
${M} .sbg-head .sb-tab { display: none; }
${M} .sbg-col { gap: 8px; min-height: auto; }
${M} .sbg-panel { padding: 8px 10px; overflow: visible; min-height: auto; }
${M} .sbg-doll canvas { min-height: 150px; }
${M} .sbg-row { min-height: 44px; }
${M} .sbg-cell { height: 66px; }
${M} .sbg-shop .sbg-cell { height: auto; min-height: 96px; }
${M} .sbg-inv .sbg-btn { min-height: 44px; min-width: 44px !important; padding: 4px 12px; }
${M} .sbg-chipbtn { display: inline-flex; align-items: center; min-height: 44px; padding: 0 10px; }
${M} .sbg-card, ${M} .sbg-empty { max-width: none; }
${M} .sbg-foot { position: sticky; bottom: 0; z-index: 1; margin: 0 -12px; padding: 8px 12px calc(var(--sab) + 8px); background: var(--floor, #1C1E21); }
${M} .sbg-foot > span { display: none; }
${M} .sbg-close { min-height: 44px; padding: 0 20px; }
${M} .sbg-shop .buy { max-width: none; }

/* co-op lobby (F2 on desktop; the CO-OP menu row here) */
${M} .sb.sbn-lobby { align-items: flex-start; overflow-y: auto; padding: calc(var(--sat) + 8px) 8px calc(var(--sab) + 8px); }
${M} .sbn-card { margin: auto 0; }
${M} .sbn-body { padding: 12px; }
${M} .sbn-title { font-size: 22px; }
${M} .sbn-btn { height: 44px; }
${M} .sbn-lobby input { height: 44px; }
${M} .sbn-codebig { font-size: 40px; margin: 4px 0 8px; }
${M} .sbn-head { margin-bottom: 8px; }
${M} .sbn-field { margin-bottom: 10px; }
`;
