/**
 * Injected CSS + fonts for the HUD (docs/ART_DIRECTION.md §10): stadium scoreboard and
 * station safety signage. Archivo (expanded) for names, Saira Stencil One for big numerals,
 * Martian Mono for every number/label. Flat opaque rectangles, hairlines, hazard tabs,
 * segmented gauges. No outlines, no text-shadows, no skew, no rounded corners, no blur.
 *
 * Accessibility floor: no text below 12 px (also at 1280×720), body text on opaque panels
 * (--label #9A9890 / --dim #8E8C86 on --panel-solid are ≥ 5:1), rarity always carries a label.
 * Layout snaps to an 8 px grid with 32 px screen margins.
 */

export const FONT_HREF =
  'https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=Martian+Mono:wght@400;700&family=Saira+Stencil+One&display=swap';

export function injectStyles(): void {
  if (!document.getElementById('sb-fonts')) {
    const pre1 = document.createElement('link');
    pre1.rel = 'preconnect';
    pre1.href = 'https://fonts.googleapis.com';
    const pre2 = document.createElement('link');
    pre2.rel = 'preconnect';
    pre2.href = 'https://fonts.gstatic.com';
    pre2.crossOrigin = '';
    const link = document.createElement('link');
    link.id = 'sb-fonts';
    link.rel = 'stylesheet';
    link.href = FONT_HREF;
    document.head.append(pre1, pre2, link);
  }
  if (!document.getElementById('sb-styles')) {
    const style = document.createElement('style');
    style.id = 'sb-styles';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
}

const CSS = /* css */ `
.sb {
  position: absolute; inset: 0; overflow: hidden; pointer-events: none;
  font-family: 'Martian Mono', 'Consolas', monospace; color: var(--bone);
  --bone: #ECEAE4; --panel: rgba(20,21,22,.88); --panel-solid: #141516; --dim: #8E8C86; --label: #9A9890;
  --rule: #3A3C40; --shield: #CFE3EA; --health: #E0402F; --accent: #FF5F1F; --threat: #FF2238;
  --track: #2E3134; --floor: #1C1E21; --grid: #26282B;
  --display: 'Archivo', 'Arial', sans-serif; --stencil: 'Saira Stencil One', 'Arial Black', sans-serif; --mono: 'Martian Mono', 'Consolas', monospace;
  font-size: 12px; letter-spacing: 0; -webkit-font-smoothing: antialiased;
}
.sb * { box-sizing: border-box; }
.sb-hidden { display: none !important; }

/* building blocks ---------------------------------------------------------- */
.sb-panel { background: var(--panel); border-top: 2px solid var(--bone); padding: 12px 16px; }
.sb-solid { background: var(--panel-solid); }
.sb-name { font-family: var(--display); font-stretch: 125%; font-weight: 800; letter-spacing: -0.01em; text-transform: uppercase; }
.sb-num { font-family: var(--stencil); font-weight: 400; line-height: 1; }
.sb-lbl { font-family: var(--mono); font-size: 12px; font-weight: 400; letter-spacing: .12em; text-transform: uppercase; color: var(--label); }
.sb-val { font-family: var(--mono); font-size: 14px; font-weight: 700; color: var(--bone); }
.sb-tab { height: 8px; background: repeating-linear-gradient(-45deg, var(--panel-solid) 0 6px, var(--tabc, var(--accent)) 6px 12px); }
.sb-tab.thin { height: 5px; }
.sb-tab.threat { --tabc: var(--threat); }
.sb-tab.bone { --tabc: var(--bone); }
.sb-gauge { position: relative; height: 10px; background: var(--track); overflow: hidden; }
.sb-gauge .fill { position: absolute; inset: 0; transform-origin: left center; transition: transform .12s linear; }
.sb-gauge .mask { position: absolute; inset: 0; background: repeating-linear-gradient(90deg, transparent 0 var(--seg), var(--panel-solid) var(--seg) calc(var(--seg) + 2px)); }
.sb-key { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; height: 24px; padding: 0 6px; border: 2px solid var(--bone); font-family: var(--mono); font-weight: 700; font-size: 12px; line-height: 1; color: var(--bone); margin-right: 8px; white-space: nowrap; }
.sb-act { font-family: var(--mono); font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.sb-sq { display: inline-block; width: 10px; height: 10px; margin-right: 8px; vertical-align: 0; flex: none; }

/* HUD layer ----------------------------------------------------------------- */
.sb-hud { position: absolute; inset: 0; transition: opacity .15s linear; }
.sb-hud.sb-dim { opacity: 0; }

/* crosshair: 4 bars 2 × 12, 8 px gap, 1 px 50 % backing */
.sb-ch { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }
.sb-ch i { position: absolute; background: var(--bone); box-shadow: 0 0 0 1px rgba(20,21,22,.5); }
.sb-ch .t, .sb-ch .b { width: 2px; height: 12px; left: -1px; }
.sb-ch .l, .sb-ch .r { width: 12px; height: 2px; top: -1px; }
.sb-hit { position: absolute; left: 50%; top: 50%; width: 0; height: 0; opacity: 0; --hc: var(--bone); }
.sb-hit i { position: absolute; width: 8px; height: 8px; border-color: var(--hc); border-style: solid; border-width: 0; }
.sb-hit i:nth-child(1) { left: -14px; top: -14px; border-left-width: 2px; border-top-width: 2px; }
.sb-hit i:nth-child(2) { left: 6px; top: -14px; border-right-width: 2px; border-top-width: 2px; }
.sb-hit i:nth-child(3) { left: -14px; top: 6px; border-left-width: 2px; border-bottom-width: 2px; }
.sb-hit i:nth-child(4) { left: 6px; top: 6px; border-right-width: 2px; border-bottom-width: 2px; }
.sb-hit b { position: absolute; left: -3px; top: -3px; width: 6px; height: 6px; background: var(--bone); display: none; }
.sb-hit.crit { --hc: var(--accent); }
.sb-hit.kill b { display: block; }

/* vitals (bottom-left, 340 px) */
.sb-vitals { position: absolute; left: 32px; bottom: 32px; width: 340px; }
.sb-vitals .lowtab { position: absolute; left: 0; right: 0; top: -10px; opacity: 0; }
.sb-vitals.low .lowtab { opacity: 1; animation: sb-blink .5s steps(1) infinite; --tabc: var(--health); }
.sb-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 8px; }
.sb-row + .sb-gauge { margin-bottom: 16px; }
.sb-gauge.shield { height: 10px; --seg: calc((100% - 38px) / 20); }
.sb-gauge.shield .fill { background: var(--shield); }
.sb-gauge.shield.flash .fill { background: var(--bone); }
.sb-gauge.health { height: 16px; --seg: calc((100% - 18px) / 10); }
.sb-gauge.health .fill { background: var(--health); }
.sb-gauge .lag { position: absolute; inset: 0; transform-origin: left center; background: var(--bone); opacity: .55; transition: transform .3s linear .3s; }
.sb-foot { display: flex; align-items: center; gap: 12px; padding-top: 8px; border-top: 1px solid var(--rule); }
.sb-foot .xp { flex: 1; height: 2px; background: var(--track); position: relative; }
.sb-foot .xp i { position: absolute; inset: 0; background: var(--accent); transform-origin: left; transition: transform .2s linear; }
.sb-gren { display: flex; gap: 4px; }
.sb-gren i { width: 8px; height: 8px; background: var(--bone); }
.sb-gren i.off { background: var(--track); }
.sb-pts { position: absolute; left: 0; top: -48px; height: 32px; display: flex; align-items: center; background: var(--accent); color: var(--panel-solid); padding: 0 8px 0 12px; font-family: var(--mono); font-weight: 700; font-size: 12px; letter-spacing: .12em; }
.sb-pts .sb-key { border-color: var(--panel-solid); color: var(--panel-solid); margin: 0 0 0 12px; }

/* ammo (bottom-right, 330 px) */
.sb-ammo { position: absolute; right: 32px; bottom: 32px; width: 330px; }
.sb-ammo .reltab { position: absolute; left: 0; right: 0; top: 50%; height: 10px; margin-top: -5px; opacity: 0; }
.sb-ammo.reloading .reltab { opacity: .9; }
.sb-ammo .top { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
.sb-mag { font-family: var(--mono); font-weight: 700; font-size: 52px; line-height: .9; letter-spacing: -0.02em; }
.sb-mag.low { color: var(--health); }
.sb-res { font-family: var(--mono); font-size: 18px; color: var(--label); margin-left: 8px; }
.sb-slots { font-family: var(--mono); font-size: 12px; letter-spacing: .1em; color: var(--label); text-align: right; white-space: nowrap; }
.sb-slots b { color: var(--bone); font-weight: 700; }
.sb-pips { display: flex; gap: 2px; height: 10px; margin: 8px 0; }
.sb-pips i { flex: 1; background: var(--bone); }
.sb-pips i.off { background: var(--track); }
.sb-pips.cont { display: block; position: relative; background: var(--track); --seg: 6px; }
.sb-pips.cont .fill { position: absolute; inset: 0; background: var(--bone); transform-origin: left; }
.sb-pips.cont .mask { position: absolute; inset: 0; background: repeating-linear-gradient(90deg, transparent 0 6px, var(--panel-solid) 6px 8px); }
.sb-wname { display: flex; align-items: center; font-family: var(--display); font-stretch: 125%; font-weight: 800; font-size: 14px; letter-spacing: -0.01em; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sb-wname .nm { overflow: hidden; text-overflow: ellipsis; }
.sb-wsub { margin-top: 4px; letter-spacing: .06em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* round plate (top-left) */
.sb-round { position: absolute; left: 32px; top: 32px; min-width: 248px; display: flex; gap: 16px; align-items: center; }
.sb-round .big { font-family: var(--stencil); font-size: 48px; line-height: 1; color: var(--accent); min-width: 56px; }
.sb-round .lines { display: flex; flex-direction: column; gap: 8px; }

/* hype (top-right, 216 px) + mute row */
.sb-hype { position: absolute; right: 32px; top: 32px; width: 216px; }
.sb-hype .sb-row { margin-bottom: 0; }
.sb-hype .sb-gauge { height: 10px; --seg: calc((100% - 18px) / 10); margin: 8px 0; }
.sb-hype .sb-gauge .fill { background: var(--accent); }
.sb-hype .ev { font-family: var(--mono); font-size: 12px; letter-spacing: .06em; color: var(--bone); min-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-transform: uppercase; }
.sb-hype .ev.neg { color: var(--dim); }
.sb-hype .chip { display: inline-block; margin-top: 8px; font-family: var(--mono); font-size: 12px; font-weight: 700; letter-spacing: .08em; padding: 2px 6px; background: var(--bone); color: var(--panel-solid); }
.sb-hype .chip.boo { background: var(--track); color: var(--bone); }
.sb-hype .mute { display: flex; align-items: center; gap: 8px; margin: 8px -16px -12px; padding: 4px 16px; background: var(--bone); color: var(--panel-solid); font-family: var(--mono); font-size: 12px; font-weight: 700; letter-spacing: .12em; }
.sb-hype .mute .sb-key { border-color: var(--panel-solid); color: var(--panel-solid); min-width: 20px; height: 20px; margin: 0 0 0 auto; }
/* mount point for extra standing widgets (src/standing/hud.ts) */
.sb-standing-mount { position: absolute; right: 32px; top: 184px; }

/* boss bar (top centre, 640 px; shrinks between the corner plates) */
.sb-boss { position: absolute; top: 32px; left: 50%; width: min(760px, calc(100vw - 2 * 312px)); transform: translateX(-50%); }
.sb-boss .head { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; min-width: 0; }
.sb-boss .tag { background: var(--accent); color: var(--panel-solid); font-family: var(--mono); font-weight: 700; font-size: 12px; letter-spacing: .12em; padding: 2px 8px; flex: none; }
.sb-boss .bname { font-family: var(--display); font-stretch: 125%; font-weight: 800; font-size: 22px; line-height: 1.1; letter-spacing: -0.01em; text-transform: uppercase; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sb-boss .ph { font-family: var(--mono); font-size: 12px; font-weight: 700; letter-spacing: .08em; flex: none; white-space: nowrap; }
.sb-boss .shl { height: 4px; background: var(--bone); transform-origin: left; margin-bottom: 2px; transition: transform .2s linear; }
.sb-boss .hp { position: relative; height: 14px; background: var(--track); overflow: hidden; }
.sb-boss .hp .lag { position: absolute; inset: 0; background: var(--bone); transform-origin: left; transition: transform .3s linear .3s; }
.sb-boss .hp .fill { position: absolute; inset: 0; background: var(--threat); transform-origin: left; transition: transform .1s linear; }
.sb-boss .hp .notch { position: absolute; top: 0; bottom: 0; width: 3px; background: var(--panel-solid); }
.sb-boss .sb-tab { margin-top: 8px; }
.sb-boss.in { animation: sb-in-top .18s ease-out; }
@media (max-width: 1360px) { .sb-boss .bname { font-size: 18px; } }

/* damage tags */
.sb-dmg { position: absolute; left: 0; top: 0; display: flex; align-items: baseline; gap: 6px; font-family: var(--mono); font-weight: 700; font-size: 14px; line-height: 1; padding: 4px 6px; background: var(--panel-solid); color: var(--bone); white-space: nowrap; will-change: transform; }
.sb-dmg.crit { font-size: 20px; background: var(--bone); color: var(--panel-solid); padding: 4px 8px; }
.sb-dmg.crit::before { content: 'CRIT'; font-size: 12px; letter-spacing: .12em; }

/* damage direction + low health edge */
.sb-dir { position: absolute; left: 50%; top: 50%; width: 0; height: 0; opacity: 0; }
.sb-dir i { position: absolute; left: -40px; top: -152px; width: 80px; height: 4px; background: var(--health); }
.sb-lowedge { position: absolute; inset: 0; opacity: 0; background: radial-gradient(ellipse at center, rgba(0,0,0,0) 60%, rgba(224,64,47,.35) 125%); }
.sb-lowedge.on { opacity: 1; animation: sb-blink 1s steps(2) infinite; }

/* prompt + manifest (pickup) */
.sb-prompt { position: absolute; left: 50%; top: calc(50% + 80px); transform: translateX(-50%); display: flex; align-items: center; background: var(--panel); padding: 8px 12px; white-space: nowrap; max-width: calc(100vw - 2 * 400px); }
.sb-prompt .what { display: flex; align-items: center; min-width: 0; font-family: var(--display); font-stretch: 125%; font-weight: 800; font-size: 13px; text-transform: uppercase; margin-left: 12px; }
.sb-prompt .what .nm { overflow: hidden; text-overflow: ellipsis; }
.sb-prompt .rar { font-family: var(--mono); font-stretch: 100%; font-weight: 400; font-size: 12px; letter-spacing: .12em; color: var(--label); margin-left: 12px; flex: none; }
/* card sits in the right column between the hype panel and the ammo panel */
.sb-cardslot { position: absolute; right: 32px; bottom: 184px; max-height: calc(100vh - 184px - 200px); display: flex; flex-direction: column; justify-content: flex-end; }

.sb-card { width: 352px; background: var(--panel); max-height: 100%; overflow: hidden; }
.sb-card .band { display: flex; justify-content: space-between; padding: 4px 12px; color: var(--panel-solid); font-family: var(--mono); font-weight: 700; font-size: 12px; letter-spacing: .12em; }
.sb-card .body { padding: 12px 12px 8px; }
.sb-card .cname { font-family: var(--display); font-stretch: 125%; font-weight: 800; font-size: 20px; line-height: 1.05; letter-spacing: -0.01em; text-transform: uppercase; }
.sb-card .csub { margin: 8px 0; }
.sb-card table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12px; }
.sb-card th { text-align: right; font-weight: 400; font-size: 12px; letter-spacing: .1em; color: var(--label); padding: 0 0 4px; border-bottom: 1px solid var(--rule); }
.sb-card th:first-child, .sb-card td:first-child { text-align: left; }
.sb-card td { text-align: right; padding: 3px 0; border-bottom: 1px solid rgba(58,60,64,.6); white-space: nowrap; }
.sb-card td.k { color: var(--label); letter-spacing: .08em; }
.sb-card td.this { font-weight: 700; }
.sb-card td.yours { color: var(--dim); }
.sb-card .up { color: var(--bone); font-weight: 700; }
.sb-card .down { color: var(--dim); }
.sb-card .elem { display: flex; align-items: center; margin-top: 8px; font-size: 12px; letter-spacing: .08em; }
.sb-card .perk { margin-top: 8px; background: var(--panel-solid); }
.sb-card .perk .pb { padding: 8px 12px; font-size: 12px; line-height: 1.5; }
.sb-card .perk b { display: block; font-family: var(--display); font-stretch: 125%; font-weight: 800; font-size: 12px; text-transform: uppercase; }
.sb-card .foot { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--rule); }
.sb-card .foot .keys { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.sb-card .foot .keys > span { display: flex; align-items: center; }
.sb-barcode { display: flex; align-items: stretch; height: 24px; gap: 1px; }
.sb-barcode i { background: var(--bone); }
.sb-serial { font-family: var(--mono); font-size: 12px; font-weight: 700; letter-spacing: .08em; color: var(--bone); margin-top: 4px; }
.sb-card.gear { background: var(--panel-solid); }
@media (max-height: 800px) {
  .sb-card .cname { font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sb-card .body { padding: 8px 12px; }
  .sb-card .csub { margin: 4px 0 8px; }
  .sb-card td { padding: 2px 0; }
  .sb-card .perk .pb { padding: 4px 12px 6px; line-height: 1.4; }
  .sb-barcode { height: 20px; }
}

/* ribbons (round banners, boss intro, cleared) */
.sb-ribbon { position: absolute; left: 0; right: 0; top: 22%; transform: translateX(-100%); }
.sb-ribbon.in { transform: translateX(0); transition: transform .18s ease-out; }
.sb-ribbon.out { transform: translateX(100%); transition: transform .18s ease-in; }
.sb-ribbon .band { background: var(--panel-solid); padding: 16px 16px; text-align: center; }
.sb-ribbon .big { font-family: var(--stencil); font-size: 72px; line-height: 1; color: var(--accent); }
.sb-ribbon .l1, .sb-ribbon .l2 { font-family: var(--mono); font-size: 13px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; margin-top: 8px; }
.sb-ribbon .l2 { color: var(--label); font-weight: 400; }
.sb-ribbon .sb-tab { height: 10px; }
.sb-ribbon.boss .band { background: var(--threat); color: var(--panel-solid); }
.sb-ribbon.boss .big { font-family: var(--display); font-stretch: 125%; font-weight: 900; font-size: 36px; color: var(--panel-solid); letter-spacing: -0.01em; text-transform: uppercase; margin-top: 8px; }
.sb-ribbon.boss .l1 { margin-top: 0; }
.sb-ribbon.boss .l2 { color: var(--panel-solid); }
.sb-ribbon.boss .sb-tab { --tabc: var(--threat); }
.sb-ribbon.cleared .band { background: var(--bone); color: var(--panel-solid); }
.sb-ribbon.cleared .big { color: var(--panel-solid); }
.sb-ribbon.cleared .l2 { color: #3A3C40; }
@media (max-height: 800px) { .sb-ribbon .big { font-size: 56px; } .sb-ribbon .band { padding: 12px 16px; } }

/* level up: BONE ribbon, bottom centre between the vitals and ammo panels; wipes in left→right */
.sb-level { position: absolute; left: 50%; bottom: 32px; width: 480px; margin-left: -240px; clip-path: inset(0 100% 0 0); }
.sb-level.in { clip-path: inset(0 0 0 0); transition: clip-path .18s linear; }
.sb-level.out { clip-path: inset(0 0 0 100%); transition: clip-path .18s linear; }
.sb-level .band { background: var(--bone); color: var(--panel-solid); text-align: center; padding: 12px 16px; }
.sb-level .big { font-family: var(--stencil); font-size: 32px; line-height: 1; }
.sb-level .burst { display: flex; justify-content: center; gap: 4px; margin-top: 8px; }
.sb-level .burst i { width: 12px; height: 4px; background: var(--accent); }
.sb-level.in .burst i { animation: sb-pip .6s steps(1) 2; }
.sb-level.in .burst i:nth-child(even) { animation-delay: .15s; }

/* messages (bottom centre, above the level ribbon) */
.sb-msgs { position: absolute; bottom: 128px; left: 50%; transform: translateX(-50%); width: min(520px, calc(100vw - 2 * 388px)); display: flex; flex-direction: column-reverse; align-items: center; gap: 4px; }
.sb-msg { max-width: 100%; background: var(--panel); padding: 6px 12px; font-family: var(--mono); font-size: 12px; font-weight: 700; letter-spacing: .1em; line-height: 1.4; text-transform: uppercase; text-align: center; border-left: 4px solid var(--bone); transition: opacity .2s linear; }
.sb-msg.warning { border-left-color: var(--health); }
.sb-msg.warning::before { content: '▲ '; }
.sb-msg.legendary { border-left-color: #FF9A1F; color: #FF9A1F; }
.sb-msg.out { opacity: 0; }

/* screens ---------------------------------------------------------------------- */
.sb-screen { position: absolute; inset: 0; pointer-events: auto; background: #0c0d0e; cursor: pointer; overflow: hidden; }
.sb-screen.overlay { background: rgba(12,13,14,.86); }
.sb-screen.skills-screen { cursor: default; background: var(--floor); }
.sb-shaftbg { position: absolute; inset: 0; pointer-events: none;
  background:
    linear-gradient(115deg, transparent 0 38%, rgba(243,238,223,.07) 46%, rgba(243,238,223,.13) 50%, rgba(243,238,223,.06) 55%, transparent 63%),
    radial-gradient(ellipse 60% 40% at 50% 100%, rgba(169,171,173,.10), transparent 70%),
    linear-gradient(180deg, #08090a 0%, #121315 60%, #1a1b1d 100%); }
.sb-gateart { position: absolute; left: 50%; bottom: 0; width: min(560px, 60vw); height: 54vh; transform: translateX(-50%); pointer-events: none; }
.sb-gateart .jamb { position: absolute; bottom: 0; width: 13%; height: 100%; background: #2a2b2c; }
.sb-gateart .jamb.l { left: 0; } .sb-gateart .jamb.r { right: 0; }
.sb-gateart .lintel { position: absolute; left: 0; right: 0; top: 0; height: 12%; background: #2f3031; }
.sb-gateart .lintel i { position: absolute; left: 13%; right: 13%; bottom: 0; height: 6px; background: var(--accent); }
.sb-gateart .door { position: absolute; bottom: 0; top: 12%; width: 37%; background: #1b1c1e; border-top: 1px solid #2a2c2f; }
.sb-gateart .door.l { left: 13%; border-right: 2px solid #0c0d0e; } .sb-gateart .door.r { right: 13%; }
.sb-gateart .door b { position: absolute; top: 0; bottom: 0; width: 2px; background: #25272a; }
.sb-gateart .floor { position: absolute; left: -40%; right: -40%; bottom: 0; height: 6px; background: repeating-linear-gradient(-45deg, #141516 0 8px, #C9A227 8px 16px); opacity: .5; }

/* start: left column (title, menu, plaque) + right column (controls / sponsor / settings) */
.sb-start { position: absolute; inset: 0; display: grid; grid-template-columns: minmax(0, 1fr) 480px; grid-template-rows: auto minmax(0, 1fr) auto; gap: 24px 32px; padding: 32px; }
.sb-start .tb { grid-column: 1; grid-row: 1; }
.sb-start .sb-menu { grid-column: 1; grid-row: 2; align-self: center; }
.sb-start .sb-plaque { grid-column: 1; grid-row: 3; align-self: end; }
.sb-start .side { grid-column: 2; grid-row: 1 / 3; align-self: end; max-height: 100%; overflow: auto; cursor: default; }
.sb-start .sb-cta { grid-column: 2; grid-row: 3; justify-self: end; align-self: end; }
.sb-title { font-family: var(--display); font-stretch: 125%; font-weight: 900; font-size: clamp(40px, min(6.4vw, 9vh), 96px); line-height: .92; letter-spacing: -0.02em; color: var(--bone); }
.sb-tagline { font-family: var(--mono); font-size: 12px; letter-spacing: .16em; color: var(--label); margin-top: 16px; }
.sb-menu { width: 360px; display: flex; flex-direction: column; gap: 2px; }
.sb-menu button { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 16px; min-height: 40px; padding: 8px 16px; background: var(--panel); font-family: var(--mono); font-size: 13px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--bone); cursor: pointer; }
.sb-menu button .n { color: var(--label); font-weight: 400; }
.sb-menu button .v { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sb-menu button .r { margin-left: auto; color: var(--label); font-weight: 400; font-size: 12px; white-space: nowrap; }
.sb-menu button:hover, .sb-menu button.sel, .sb-menu button:focus-visible { background: var(--bone); color: var(--panel-solid); }
.sb-menu button:hover .n, .sb-menu button.sel .n, .sb-menu button:hover .r, .sb-menu button.sel .r, .sb-menu button:focus-visible .n, .sb-menu button:focus-visible .r { color: #3A3C40; }
.sb-menu button.open { box-shadow: inset 4px 0 0 var(--accent); }
.sb-side-panel .hd { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; margin-bottom: 8px; }
.sb-controls .grid { display: grid; grid-template-columns: auto 1fr auto 1fr; gap: 8px 12px; align-items: center; }
.sb-controls .grid .sb-key { margin: 0; justify-self: start; }
.sb-controls .grid .d { font-size: 12px; letter-spacing: .1em; text-transform: uppercase; color: var(--bone); white-space: nowrap; }
.sb-plaque { width: min(560px, 100%); }
.sb-plaque .sb-panel { border-top: 0; padding-bottom: 8px; }
.sb-plaque .pl { font-family: var(--mono); font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
.sb-plaque .pl b { color: var(--accent); }
.sb-plaque .best { background: var(--panel); padding: 0 16px 12px; }
.sb-cta { font-family: var(--mono); font-size: 14px; font-weight: 700; letter-spacing: .16em; color: var(--bone); background: var(--panel); padding: 12px 16px; border-top: 2px solid var(--accent); white-space: nowrap; }
.sb-cta::after { content: ' ▸'; color: var(--accent); }
.sb-cta.wait::after { content: ' ■'; animation: sb-blink 1s steps(1) infinite; }
@media (max-width: 1180px) { .sb-start { grid-template-columns: minmax(0, 1fr) 400px; } .sb-controls .grid { grid-template-columns: auto 1fr; } }

/* settings panel (start + pause) */
.sb-settings { cursor: default; }
.sb-set-row { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px 16px; padding: 8px 0; border-bottom: 1px solid var(--rule); }
.sb-set-row .sb-lbl { color: var(--bone); }
.sb-set-row .sb-val { min-width: 64px; text-align: right; }
.sb-set-row .ctl { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; }
.sb-range { -webkit-appearance: none; appearance: none; flex: 1; height: 24px; background: transparent; margin: 0; cursor: pointer; }
.sb-range:focus { outline: none; }
.sb-range::-webkit-slider-runnable-track { height: 8px; background: linear-gradient(90deg, var(--bone) 0 var(--p, 50%), var(--track) var(--p, 50%) 100%); }
.sb-range::-moz-range-track { height: 8px; background: var(--track); }
.sb-range::-moz-range-progress { height: 8px; background: var(--bone); }
.sb-range::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 24px; margin-top: -8px; background: var(--accent); border: 0; border-radius: 0; }
.sb-range::-moz-range-thumb { width: 16px; height: 24px; background: var(--accent); border: 0; border-radius: 0; }
.sb-range:focus-visible::-webkit-slider-thumb { outline: 2px solid var(--bone); outline-offset: 2px; }
.sb-step { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: 2px solid var(--bone); font-family: var(--mono); font-weight: 700; font-size: 14px; cursor: pointer; }
.sb-step:hover { background: var(--bone); color: var(--panel-solid); }
.sb-toggle { all: unset; box-sizing: border-box; display: inline-flex; gap: 2px; cursor: pointer; }
.sb-toggle span { padding: 4px 8px; font-family: var(--mono); font-weight: 700; font-size: 12px; letter-spacing: .12em; background: var(--track); color: var(--label); }
.sb-toggle span.on { background: var(--bone); color: var(--panel-solid); }
.sb-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.sb-settings .note { margin-top: 8px; }
.sb-settings .acts { display: flex; justify-content: flex-end; margin-top: 12px; }

.sb-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 24px; padding: 32px 0; }
.sb-band { width: 100%; }
.sb-band .inner { background: var(--panel-solid); text-align: center; padding: 16px 16px 24px; }
.sb-band .t { font-family: var(--stencil); font-size: 64px; line-height: 1; color: var(--bone); }
.sb-band .s { font-family: var(--mono); font-size: 12px; letter-spacing: .14em; color: var(--label); margin-top: 8px; text-transform: uppercase; }
.sb-band.threat .inner { background: var(--threat); }
.sb-band.threat .t { color: var(--panel-solid); font-family: var(--display); font-stretch: 125%; font-weight: 900; font-size: 52px; letter-spacing: -0.01em; }
.sb-band.threat .s { color: var(--panel-solid); font-weight: 700; }
.sb-pause-row { display: flex; gap: 32px; align-items: flex-start; justify-content: center; }
.sb-pause-row .sb-settings { width: 400px; }
@media (max-height: 800px) { .sb-band .t { font-size: 48px; } .sb-band.threat .t { font-size: 40px; } .sb-center { gap: 16px; } .sb-band .inner { padding: 12px 16px 16px; } }

/* game over: manifest recap + standing */
.sb-over-row { display: flex; gap: 32px; align-items: flex-start; justify-content: center; }
.sb-recap { width: 440px; }
.sb-recap .hd { display: flex; justify-content: space-between; margin-bottom: 4px; }
.sb-recap table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 13px; }
.sb-recap td { padding: 6px 0; border-bottom: 1px solid var(--rule); }
.sb-recap td:first-child { color: var(--label); letter-spacing: .12em; font-size: 12px; text-transform: uppercase; }
.sb-recap td:last-child { text-align: right; font-weight: 700; }
.sb-recap tr.big td:last-child { font-family: var(--stencil); font-weight: 400; font-size: 28px; line-height: 1; color: var(--accent); }
.sb-mini { display: inline-grid; grid-template-columns: auto auto; align-items: center; justify-content: end; gap: 0 8px; text-align: right; }
.sb-mini .nm { font-family: var(--display); font-stretch: 125%; font-weight: 800; font-size: 13px; text-transform: uppercase; }
.sb-mini .sub { grid-column: 1 / -1; font-weight: 400; font-size: 12px; letter-spacing: .1em; color: var(--label); text-transform: uppercase; }
.sb-over-side { width: 400px; display: flex; flex-direction: column; gap: 16px; }
.sb-over-acts { display: flex; gap: 16px; align-items: center; }
.sb-over-acts .sb-menu { width: auto; flex-direction: row; }
@media (max-height: 800px) { .sb-recap td { padding: 4px 0; } }

/* skill tree: floor plan */
.sb-floorplan { position: absolute; inset: 0; background-color: var(--floor);
  background-image: linear-gradient(var(--grid) 2px, transparent 2px), linear-gradient(90deg, var(--grid) 2px, transparent 2px);
  background-size: 40px 40px; background-position: -1px -1px; }
.sb-skills { position: absolute; inset: 0; padding: 32px; }
.sb-skills-head { display: flex; justify-content: space-between; align-items: flex-start; }
.sb-skills-head .h { font-family: var(--display); font-stretch: 125%; font-weight: 900; font-size: 32px; letter-spacing: -0.01em; margin-top: 4px; }
.sb-chip { background: var(--accent); color: var(--panel-solid); font-family: var(--mono); font-weight: 700; font-size: 12px; letter-spacing: .12em; padding: 8px 12px; }
.sb-plan { position: absolute; left: 32px; top: 136px; }
.sb-plan svg { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
.sb-bhead { position: absolute; font-family: var(--mono); font-size: 12px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--bone); white-space: nowrap; background: var(--floor); padding-right: 8px; }
.sb-plinth { position: absolute; width: 72px; height: 72px; display: flex; align-items: center; justify-content: center; background: #2E3134; color: var(--bone); cursor: pointer; pointer-events: auto; }
.sb-plinth .code { font-family: var(--stencil); font-size: 30px; line-height: 1; }
.sb-plinth.invested { background: var(--bone); color: var(--panel-solid); }
.sb-plinth.avail { box-shadow: inset 0 -4px 0 var(--accent); }
.sb-plinth.locked { background: transparent; outline: 2px dashed #5A5C60; outline-offset: -2px; color: var(--dim); cursor: default; }
.sb-plinth.sel { outline: 2px solid var(--accent); outline-offset: 4px; }
.sb-plinth .rk { position: absolute; left: 0; right: 0; bottom: -16px; display: flex; justify-content: center; gap: 4px; }
.sb-plinth .rk i { width: 10px; height: 6px; background: #3A3C40; }
.sb-plinth .rk i.on { background: var(--accent); }
.sb-plinth .nm { position: absolute; left: 88px; top: 8px; width: 144px; text-align: left; pointer-events: none; }
.sb-plinth .nm b { display: block; font-family: var(--display); font-stretch: 112%; font-weight: 800; font-size: 13px; line-height: 1.2; text-transform: uppercase; color: var(--bone); }
.sb-plinth .nm span { display: block; margin-top: 4px; font-family: var(--mono); font-size: 12px; letter-spacing: .08em; color: var(--label); }
.sb-detail { position: absolute; right: 32px; bottom: 32px; width: 360px; }
.sb-detail .dn { font-family: var(--display); font-stretch: 125%; font-weight: 800; font-size: 18px; text-transform: uppercase; margin-top: 4px; }
.sb-detail .dd { margin: 8px 0; font-size: 12px; line-height: 1.5; color: var(--bone); }
.sb-detail .dv { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 13px; font-weight: 700; margin: 8px 0; }
.sb-detail .acts { display: flex; gap: 16px; margin-top: 12px; align-items: center; }
.sb-btn { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; min-height: 32px; font-family: var(--mono); font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--bone); padding: 4px 12px; background: var(--panel); border-top: 2px solid var(--bone); }
.sb-btn .sb-key { min-width: 20px; height: 20px; }
.sb-btn:hover:not(:disabled), .sb-btn:focus-visible { background: var(--bone); color: var(--panel-solid); }
.sb-btn:hover:not(:disabled) .sb-key { border-color: var(--panel-solid); color: var(--panel-solid); }
.sb-btn:disabled { opacity: .45; cursor: default; }
.sb-skills-foot { position: absolute; left: 32px; bottom: 32px; display: flex; gap: 16px; align-items: center; }

/* animations: linear, no bounce */
@keyframes sb-blink { 50% { opacity: 0; } }
@keyframes sb-pip { 50% { opacity: 0; } }
@keyframes sb-in-top { from { transform: translateX(-50%) translateY(-12px); opacity: 0; } to { transform: translateX(-50%); opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .sb-vitals.low .lowtab, .sb-lowedge.on, .sb-level.in .burst i { animation: none; } }
`;
