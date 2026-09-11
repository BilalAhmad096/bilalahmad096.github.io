// js/resilient.js
//
// "Does resilience change the investment?" - the drawing and the wiring.
//
// One warehouse, three pathways, and four settings a visitor can change. The
// physics, the costs and the carbon accounting are in lib/site.js and are
// tested separately; the data is frozen in data/site-warehouse.json, so the
// page gives the same answer every time it is opened.

import { RIDE_THROUGH_HOURS, essentialLoad, solvePathways } from './lib/site.js';

const CASE_URL = '/data/site-warehouse.json?v=20260911-1';

const state = {
  caseData: null,
  hours: 4,
  hazard: 'correlated',
  connection: 'today',
  diesel: false,
  show: 3,
  result: null
};

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const svg = (tag, attrs = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
  return node;
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const num = (v, digits = 0) => Number(v).toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const gbpM = v => `£${num(v / 1e6, 2)}m`;
const gbpK = v => (Math.abs(v) >= 1e6 ? gbpM(v) : `£${num(Math.round(v / 1000))}k`);
const tonnes = v => (Math.abs(v) < 0.05 ? '0 t' : `${num(v, v < 10 ? 1 : 0)} t`);
const kw = v => `${num(Math.round(v))} kW`;
const kwh = v => (v >= 1000 ? `${num(v / 1000, v % 1000 ? 1 : 0)} MWh` : `${num(Math.round(v))} kWh`);
const clock = slot => `${String(Math.floor(slot / 2)).padStart(2, '0')}:${slot % 2 ? '30' : '00'}`;

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

const CONTROLS = [
  {
    key: 'hours',
    label: 'Ride-through requirement',
    hint: 'How long the cold store and IT must keep running in a grid outage.',
    options: RIDE_THROUGH_HOURS.map(h => ({ value: h, label: h ? `${h} h` : 'None' }))
  },
  {
    key: 'hazard',
    label: 'Outage conditions',
    hint: 'Treat the outage as independent of the weather, or as arriving with it.',
    options: [
      { value: 'independent', label: 'Independent' },
      { value: 'correlated', label: 'Correlated' }
    ]
  },
  {
    key: 'connection',
    label: 'Grid connection',
    hint: 'The import capacity the site has agreed with its network operator.',
    options: [
      { value: 'today', label: '800 kVA today' },
      { value: 'reinforced', label: '1,200 kVA reinforced' }
    ]
  },
  {
    key: 'diesel',
    label: 'New diesel generator',
    hint: 'Often the cheapest resilience, and a new source of Scope 1 emissions.',
    options: [
      { value: false, label: 'Not allowed' },
      { value: true, label: 'Allowed' }
    ]
  }
];

function buildControls(root) {
  const panel = el('div', 'rx-controls');
  CONTROLS.forEach(control => {
    const group = el('fieldset', 'rx-control');
    group.append(el('legend', 'rx-control__label', control.label));
    const row = el('div', 'rx-segments');
    control.options.forEach(option => {
      const id = `rx-${control.key}-${String(option.value)}`;
      const input = document.createElement('input');
      Object.assign(input, { type: 'radio', name: `rx-${control.key}`, id, className: 'rx-segment__input' });
      input.checked = state[control.key] === option.value;
      input.addEventListener('change', () => {
        state[control.key] = option.value;
        render();
      });
      const label = el('label', 'rx-segment', option.label);
      label.htmlFor = id;
      row.append(input, label);
    });
    group.append(row, el('p', 'rx-control__hint', control.hint));
    panel.append(group);
  });
  root.append(panel);
}

/* ------------------------------------------------------------------ *
 * Headline
 * ------------------------------------------------------------------ */

function renderHeadline(host) {
  const { headline, pathway3 } = state.result;
  host.replaceChildren();
  host.className = `rx-headline rx-headline--${headline.kind}`;
  host.append(el('p', 'rx-headline__kicker', headline.kind === 'negative'
    ? 'The central test: no change'
    : headline.kind === 'changed' ? 'The central test: the answer changed' : 'The central test: no feasible plan'));
  host.append(el('p', 'rx-headline__text', headline.text));
  const history = pathway3?.acHistory;
  if (history && history.length > 1) {
    const first = history[0];
    const last = history[history.length - 1];
    host.append(el('p', 'rx-headline__foot',
      `The AC power flow caught what the screen missed: at the planned ${kw(first.capKw)} cap, reactive power took the import to `
      + `${num(Math.round(first.importKva))} kVA against ${num(state.result.connection.ascKva)} kVA. The breach was returned to the plan `
      + `as a tighter cap, ${kw(last.capKw)}, and the plan was re-run until it fitted.`));
  }
}

/* ------------------------------------------------------------------ *
 * The three pathway cards
 * ------------------------------------------------------------------ */

function row(label, value, note, tone) {
  const item = el('div', `rx-row${tone ? ` rx-row--${tone}` : ''}`);
  item.append(el('dt', 'rx-row__label', label));
  const dd = el('dd', 'rx-row__value');
  dd.append(el('span', null, value));
  if (note) dd.append(el('span', 'rx-row__note', note));
  item.append(dd);
  return item;
}

function chip(text, tone) {
  return el('span', `rx-chip rx-chip--${tone}`, text);
}

function installs(p, isExisting) {
  if (isExisting) return ['Gas boilers, diesel vans and the grid', 'no new energy assets'];
  const parts = [];
  parts.push(p.plan.pvKwp ? `${num(p.plan.pvKwp)} kWp solar` : 'no solar');
  if (p.plan.battery) {
    const reserve = p.floorKwh > 1e-6 ? `, ${Math.round((100 * p.floorKwh) / p.plan.battery.energyKwh)}% held in reserve` : '';
    parts.push(`${kw(p.plan.battery.powerKw)} / ${kwh(p.plan.battery.energyKwh)} battery${p.plan.islanding ? ', able to island' : ''}${reserve}`);
  } else {
    parts.push('no battery');
  }
  if (p.plan.generatorKw) parts.push(`${kw(p.plan.generatorKw)} diesel standby`);
  return [parts[0], parts.slice(1).join('; ')];
}

function pathwayCard(index, p) {
  const { result } = state;
  const meta = [
    null,
    { title: 'Existing arrangement', sub: 'Gas heating, diesel vans and grid supply, as the site runs today.' },
    { title: 'Cost + carbon', sub: 'The cheapest plan that meets the carbon target, judged on annual energy and carbon figures alone.' },
    { title: 'Cost + carbon + engineering', sub: 'The same objective, but the plan must fit the connection, pass an AC power flow and ride through the outage.' }
  ][index];

  const card = el('article', `rx-card${index === 3 ? ' rx-card--engineered' : ''}`);
  const head = el('header', 'rx-card__head');
  head.append(el('span', 'rx-card__num', String(index)));
  const titles = el('div');
  titles.append(el('h4', 'rx-card__title', meta.title), el('p', 'rx-card__sub', meta.sub));
  head.append(titles);
  card.append(head);

  if (!p) {
    card.append(el('p', 'rx-card__empty', index === 3
      ? 'No plan in this option set meets every requirement on this connection. The cost-and-carbon plan could not have been built as recommended.'
      : 'No plan in this option set meets the carbon target.'));
    return card;
  }

  const list = el('dl', 'rx-rows');
  const [first, second] = installs(p, index === 1);
  list.append(row('Installs', first, second));

  if (index === 1) {
    list.append(row('Energy bill, today', `${gbpK(p.energyCostYr)} a year`,
      'Not comparable with 2 and 3, which exclude the cost of the heat pumps, chargers and vans themselves.'));
  } else {
    list.append(row('20-year cost', gbpM(p.presentCost),
      `present value at ${num(state.caseData.finance.discountRate * 100)}% real: new energy assets, energy and upkeep`));
  }

  const s12 = p.scope1 + p.scope2;
  const cut = 1 - s12 / result.baseline12;
  list.append(row('Scope 1 + 2', `${tonnes(s12)} a year`,
    index === 1 ? 'the baseline' : `${num(cut * 100)}% below today; the target is ${num(state.caseData.target.scope12CutFrac * 100)}%`));
  list.append(row('Scope 1', tonnes(p.scope1), p.plan.generatorKw ? 'includes generator test runs' : null));
  list.append(row('Scope 2, location-based', tonnes(p.scope2)));
  list.append(row('Scope 3, fuel and energy', tonnes(p.scope3), 'grid losses and well-to-tank'));
  list.append(row('Residual to neutralise', `${tonnes(p.residual)} a year`, 'with removals, once reductions are exhausted'));
  if (p.embodied > 0) list.append(row('Embodied, one-off', tonnes(p.embodied), 'Scope 3 Category 2, in the year of purchase'));

  const ac = p.ac;
  const acValue = el('span');
  acValue.append(chip(ac.pass ? 'Fits' : 'Breaches', ac.pass ? 'good' : 'bad'));
  const netItem = el('div', 'rx-row');
  netItem.append(el('dt', 'rx-row__label', 'Site network, AC check'));
  const netDd = el('dd', 'rx-row__value');
  netDd.append(acValue, el('span', 'rx-row__note', ac.pass
    ? `import ${num(Math.round(ac.importKva))} of ${num(result.connection.ascKva)} kVA; transformer at ${num(Math.round(ac.transformerLoading * 100))}%`
    : ac.binding));
  netItem.append(netDd);
  list.append(netItem);

  const res = p.resilience;
  const resItem = el('div', 'rx-row');
  resItem.append(el('dt', 'rx-row__label', 'Outage ride-through'));
  const resDd = el('dd', 'rx-row__value');
  if (!state.hours) {
    resDd.append(el('span', 'rx-row__note', 'no requirement set'));
  } else if (res.pass) {
    resDd.append(chip(`Holds ${state.hours} h`, 'good'),
      el('span', 'rx-row__note', 'essential load carried from every start time in the scenario day'));
  } else {
    const why = p.plan.battery && !p.plan.islanding
      ? ' Its battery is not built to island, so it trips with the grid.'
      : '';
    const when = res.heldHours > 0
      ? `essential load lost after ${num(res.heldHours, res.heldHours % 1 ? 1 : 0)} h at the worst start`
      : 'nothing can carry essential load once the grid goes';
    resDd.append(chip('Fails', 'bad'), el('span', 'rx-row__note',
      `${when}: ${kwh(res.worstEnsKwh)} unserved over ${state.hours} h, `
      + `${gbpK(p.vollPerEvent)} per event at the GB value of lost load.${why}`));
  }
  resItem.append(resDd);
  list.append(resItem);

  card.append(list);
  return card;
}

function renderCards(host) {
  const { pathway1, pathway2, pathway3 } = state.result;
  host.replaceChildren(pathwayCard(1, pathway1), pathwayCard(2, pathway2), pathwayCard(3, pathway3));
}

/* ------------------------------------------------------------------ *
 * The site one-line diagram
 * ------------------------------------------------------------------ */

const BOARDS = [
  { bus: 3, key: 'cold', label: 'Cold store', essential: true },
  { bus: 4, key: 'it', label: 'IT and safety', essential: true },
  { bus: 5, key: 'ops', label: 'Operations' },
  { bus: 6, key: 'hp', label: 'Heat pumps' },
  { bus: 7, key: 'ev', label: 'EV depot' },
  { bus: 8, key: 'pv', label: 'Roof solar' },
  { bus: 9, key: 'battery', label: 'Battery' }
];

const VIEW = { w: 940, h: 330 };
const RED = '#d03b3b';

function loadingStroke(loading) {
  if (loading > 1 + 1e-9) return RED;
  const t = Math.min(1, loading);
  const c = [Math.round(160 - 110 * t), Math.round(170 - 120 * t), Math.round(190 - 110 * t)];
  return `rgb(${c[0]} ${c[1]} ${c[2]})`;
}

function pathwayForDiagram() {
  const r = state.result;
  return [null, r.pathway1, r.pathway2, r.pathway3][state.show] || r.pathway2;
}

function renderDiagram(host, pickerHost) {
  const r = state.result;
  if (!r.pathway3 && state.show === 3) state.show = 2;

  pickerHost.replaceChildren();
  pickerHost.append(el('span', 'rx-picker__label', 'Show on the diagram'));
  [1, 2, 3].forEach(i => {
    const p = [null, r.pathway1, r.pathway2, r.pathway3][i];
    const button = el('button', `rx-picker__btn${state.show === i ? ' is-on' : ''}`, `Pathway ${i}`);
    button.type = 'button';
    button.disabled = !p;
    button.setAttribute('aria-pressed', String(state.show === i));
    button.addEventListener('click', () => { state.show = i; renderDiagram(host, pickerHost); renderStrip(document.getElementById('rxStrip')); });
    pickerHost.append(button);
  });

  const p = pathwayForDiagram();
  const ac = p.ac;
  const flows = ac.result.branches;
  const buses = new Map(ac.result.buses.map(b => [b.id, b]));
  const electrified = state.show !== 1;
  const day = ac.date === r.scenario.date ? r.scenario : state.caseData.days.find(d => d.date === ac.date);
  const k = ac.slot;

  host.replaceChildren();
  const board = svg('svg', {
    class: 'rx-diagram', viewBox: `0 0 ${VIEW.w} ${VIEW.h}`, role: 'img',
    'aria-label': `Site one-line diagram for pathway ${state.show} at its heaviest half-hour: import ${Math.round(ac.importKva)} kVA against ${r.connection.ascKva} kVA.`
  });

  const busY = 150;
  const x0 = 80;
  const x1 = VIEW.w - 60;
  const pocX = 150;

  // Point of connection, transformer, LV busbar.
  const head = flows[0];
  const over = ac.importKva > r.connection.ascKva + 1e-6;
  board.append(svg('line', { x1: pocX, y1: 34, x2: pocX, y2: 72, stroke: over ? RED : '#33415c', 'stroke-width': 3 }));
  board.append(svg('circle', { cx: pocX, cy: 84, r: 13, fill: 'none', stroke: loadingStroke(head.loading), 'stroke-width': 3 }));
  board.append(svg('circle', { cx: pocX, cy: 104, r: 13, fill: 'none', stroke: loadingStroke(head.loading), 'stroke-width': 3 }));
  board.append(svg('line', { x1: pocX, y1: 117, x2: pocX, y2: busY, stroke: loadingStroke(head.loading), 'stroke-width': 3 }));
  board.append(svg('rect', { x: x0, y: busY - 4, width: x1 - x0, height: 8, rx: 3, fill: '#0a1a3b' }));

  const t1 = svg('text', { x: pocX + 22, y: 30, class: 'rx-svg-strong' });
  t1.textContent = `Grid, 11 kV, import ${num(Math.round(ac.importKva))} kVA of ${num(r.connection.ascKva)} kVA`;
  // An inline style, not a fill attribute: the text's CSS class sets fill too,
  // and CSS always wins over an SVG presentation attribute.
  if (over) t1.style.fill = RED;
  board.append(t1);
  const t2 = svg('text', { x: pocX + 22, y: 98, class: 'rx-svg-note' });
  t2.textContent = `Transformer ${num(r.connection.transformerKva)} kVA, ${num(Math.round(head.loading * 100))}% loaded`;
  if (head.loading > 1) t2.style.fill = RED;
  board.append(t2);
  const t3 = svg('text', { x: x1, y: busY - 12, 'text-anchor': 'end', class: 'rx-svg-note' });
  t3.textContent = `LV main switchboard, ${buses.get(2).vm.toFixed(3)} pu`;
  board.append(t3);

  // Boards.
  const slotW = (x1 - x0) / BOARDS.length;
  const pv = p.plan.pvKwp ? day.pvPerKwp[k] * p.plan.pvKwp : 0;
  const trace = p.peak && p.peak.day.date === day.date ? p.peak.trace : (p.scenarioTrace && day === r.scenario ? p.scenarioTrace : null);
  const batteryKw = trace ? trace.discharge[k] - trace.charge[k] : 0;

  BOARDS.forEach((b, i) => {
    const cx = x0 + slotW * (i + 0.5);
    const flow = flows.find(f => f.to === b.bus);
    const bus = buses.get(b.bus);
    let valueKw;
    let installed = true;
    if (b.key === 'pv') { valueKw = -pv; installed = Boolean(p.plan.pvKwp); }
    else if (b.key === 'battery') { valueKw = -batteryKw; installed = Boolean(p.plan.battery); }
    else if ((b.key === 'hp' || b.key === 'ev') && !electrified) { valueKw = 0; installed = false; }
    else valueKw = day.load[b.key][k];

    const loading = flow ? flow.loading : 0;
    board.append(svg('line', {
      x1: cx, y1: busY + 4, x2: cx, y2: 232,
      stroke: installed ? loadingStroke(loading) : '#c9d3e4',
      'stroke-width': installed ? 2 + Math.min(1.2, loading) * 5 : 2,
      'stroke-dasharray': installed ? '' : '5 5'
    }));

    const w = slotW - 16;
    board.append(svg('rect', {
      x: cx - w / 2, y: 232, width: w, height: 70, rx: 9,
      fill: installed ? (b.essential ? '#fff7ec' : '#f7f9fc') : '#fbfcfe',
      stroke: installed ? (b.essential ? '#e0a445' : '#c9d3e4') : '#e3e8f1',
      'stroke-width': 1.5, 'stroke-dasharray': installed ? '' : '5 4'
    }));
    const name = svg('text', { x: cx, y: 254, 'text-anchor': 'middle', class: 'rx-svg-strong' });
    name.textContent = b.label;
    board.append(name);
    const val = svg('text', { x: cx, y: 274, 'text-anchor': 'middle', class: 'rx-svg-note' });
    val.textContent = !installed ? 'not installed'
      : b.key === 'pv' ? `${num(Math.round(pv))} kW out`
        : b.key === 'battery' ? (Math.abs(batteryKw) < 0.5 ? 'idle' : batteryKw > 0 ? `${num(Math.round(batteryKw))} kW out` : `${num(Math.round(-batteryKw))} kW in`)
          : `${num(Math.round(valueKw))} kW`;
    board.append(val);
    if (b.essential) {
      const tag = svg('text', { x: cx, y: 292, 'text-anchor': 'middle', class: 'rx-svg-tag' });
      tag.textContent = 'ESSENTIAL';
      board.append(tag);
    } else if (installed && bus) {
      const v = svg('text', { x: cx, y: 292, 'text-anchor': 'middle', class: 'rx-svg-tiny' });
      v.textContent = `${bus.vm.toFixed(3)} pu`;
      board.append(v);
    }
  });

  host.append(board);
  host.append(el('p', 'rx-caption',
    `Pathway ${state.show} at its heaviest half-hour: ${clock(k)} on ${formatDate(day.date)}. `
    + 'Line weight and colour show loading; red is a limit breached. Amber boards are the essential loads the outage test protects.'));
}

function formatDate(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/* ------------------------------------------------------------------ *
 * The outage strip
 * ------------------------------------------------------------------ */

function renderStrip(host) {
  const r = state.result;
  const p = pathwayForDiagram();
  const day = r.scenario;
  const ess = essentialLoad(day);
  const trace = p.scenarioTrace;
  const E = p.plan.battery?.energyKwh || 0;
  const W = 940;
  const H = 190;
  const padL = 44;
  const padR = 52;
  const top = 18;
  const bottom = 150;
  const x = i => padL + (i * (W - padL - padR)) / 47;
  const kwMax = Math.max(50, ...ess, ...trace.pv) * 1.15;
  const yKw = v => bottom - (v / kwMax) * (bottom - top);
  const yE = v => bottom - (E ? v / E : 0) * (bottom - top);

  host.replaceChildren();
  const board = svg('svg', {
    class: 'rx-strip', viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': `The scenario day for pathway ${state.show}: essential load, solar and battery state of charge, with the worst-case outage window.`
  });

  // Worst-case outage window, wrapping at midnight.
  if (state.hours && p.resilience) {
    const s0 = p.resilience.pass ? p.resilience.tightestStart : p.resilience.worstStart;
    const len = state.hours * 2;
    const drawWindow = (a, b) => board.append(svg('rect', {
      x: x(a) - (W - padL - padR) / 94, y: top - 6, width: Math.max(2, ((b - a) * (W - padL - padR)) / 47), height: bottom - top + 6,
      fill: p.resilience.pass ? '#2e9e6b' : RED, opacity: 0.1, rx: 3
    }));
    if (s0 + len <= 48) drawWindow(s0, s0 + len);
    else { drawWindow(s0, 48); drawWindow(0, s0 + len - 48); }
  }

  board.append(svg('line', { x1: padL, y1: bottom, x2: W - padR, y2: bottom, stroke: '#c9d3e4' }));

  // Battery state of charge, as an area against the right-hand axis.
  if (E) {
    let d = `M${x(0)},${bottom}`;
    for (let i = 0; i < 48; i++) d += `L${x(i).toFixed(1)},${yE(trace.soc[i]).toFixed(1)}`;
    d += `L${x(47)},${bottom}Z`;
    board.append(svg('path', { d, fill: '#0f66ff', opacity: 0.14 }));
    if (p.floorKwh > 1e-6) {
      board.append(svg('line', { x1: padL, y1: yE(p.floorKwh), x2: W - padR, y2: yE(p.floorKwh), stroke: '#0f66ff', 'stroke-dasharray': '6 5', 'stroke-width': 1.5 }));
    }
  }

  const line = (series, stroke, dash) => {
    let d = '';
    for (let i = 0; i < 48; i++) d += `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yKw(series[i]).toFixed(1)}`;
    board.append(svg('path', { d, fill: 'none', stroke, 'stroke-width': 2.2, 'stroke-linejoin': 'round', ...(dash ? { 'stroke-dasharray': dash } : {}) }));
  };
  if (p.plan.pvKwp) line(trace.pv, '#c98a2e', '5 4');
  line(ess, '#b4553f');

  [0, 12, 24, 36, 47].forEach(i => {
    const t = svg('text', { x: x(i), y: bottom + 18, 'text-anchor': 'middle', class: 'rx-svg-tiny' });
    t.textContent = clock(i === 47 ? 47 : i);
    board.append(t);
  });
  const axisL = svg('text', { x: 6, y: top + 4, class: 'rx-svg-tiny' });
  axisL.textContent = `${num(Math.round(kwMax))} kW`;
  board.append(axisL);
  if (E) {
    const axisR = svg('text', { x: W - 6, y: top + 4, 'text-anchor': 'end', class: 'rx-svg-tiny' });
    axisR.textContent = kwh(E);
    board.append(axisR);
  }

  host.append(board);
  const res = p.resilience;
  const where = !state.hours ? ''
    : res.pass
      ? ` Shaded: the tightest ${state.hours}-hour outage, from ${clock(res.tightestStart)}, the start that leaves least in the battery, and still carried in full.`
      : ` Shaded: the worst ${state.hours}-hour outage, from ${clock(res.worstStart)}, ${kwh(res.worstEnsKwh)} of essential load lost.`;
  host.append(el('p', 'rx-caption',
    `${r.scenario.label} scenario, ${formatDate(day.date)} (${r.scenario.weekday}), max ${num(day.tMax, 1)}°C. `
    + `Red: essential load. ${p.plan.pvKwp ? 'Amber dashes: solar. ' : ''}${E ? `Blue: battery state of charge${p.floorKwh > 1e-6 ? ', dashed line the reserve it may not trade below' : ''}. ` : ''}`
    + where));
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

let dom = null;

function render() {
  state.result = solvePathways(state.caseData, {
    hours: state.hours, hazard: state.hazard, connection: state.connection, diesel: state.diesel
  });
  renderHeadline(dom.headline);
  renderCards(dom.cards);
  renderDiagram(dom.diagram, dom.picker);
  renderStrip(dom.strip);
}

async function init() {
  const root = document.getElementById('rx');
  if (!root) return;

  try {
    const response = await fetch(CASE_URL);
    if (!response.ok) throw new Error(String(response.status));
    state.caseData = await response.json();
  } catch {
    root.replaceChildren(el('p', 'rx-status', 'Could not load the site model.'));
    return;
  }

  root.replaceChildren();
  buildControls(root);
  const headline = el('div', 'rx-headline');
  headline.setAttribute('role', 'status');
  headline.setAttribute('aria-live', 'polite');
  const cards = el('div', 'rx-cards');
  const figure = el('div', 'rx-figure');
  const picker = el('div', 'rx-picker');
  const diagram = el('div', 'rx-diagramwrap');
  figure.append(picker, diagram);
  const stripTitle = el('h4', 'rx-subtitle', 'The outage, half-hour by half-hour');
  const strip = el('div', 'rx-stripwrap');
  strip.id = 'rxStrip';
  root.append(headline, cards, figure, stripTitle, strip);

  dom = { headline, cards, picker, diagram, strip };
  render();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
