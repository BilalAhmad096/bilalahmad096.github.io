// js/contingency.js
//
// The interactive N-1 screen. Draws the IEEE 14-bus system, trips whatever the
// visitor clicks, and re-solves the AC power flow in the page - one base case
// plus twenty single-outage cases per interaction, which is a few milliseconds,
// so nothing here is precomputed or cached.
//
// The solver lives in lib/powerflow.js and is tested separately. This file is
// the drawing and the wiring.

import {
  performanceIndex,
  screenContingencies,
  solvePowerFlow,
  violations
} from './lib/powerflow.js';

const CASE_URL = '/data/case14.json';

/**
 * Hand-placed one-line layout. Follows the usual published arrangement of this
 * case - the 132 kV buses (1-5) across the top, the lower-voltage group below -
 * and is set so no two branches cross.
 */
const LAYOUT = {
  1:  { x: 150, y: 120 }, 2:  { x: 380, y: 120 }, 3:  { x: 620, y: 120 },
  4:  { x: 450, y: 250 }, 5:  { x: 240, y: 250 }, 6:  { x: 150, y: 400 },
  7:  { x: 560, y: 330 }, 8:  { x: 680, y: 330 }, 9:  { x: 560, y: 430 },
  10: { x: 450, y: 500 }, 11: { x: 300, y: 470 }, 12: { x: 150, y: 520 },
  13: { x: 280, y: 560 }, 14: { x: 480, y: 580 }
};

const VIEW = { width: 800, height: 660 };
const BUS_R = 17;

// Diverging scale for bus voltage: red below nominal, neutral at 1.00 pu, blue
// above. Deviation, not level, is what matters, which is what makes it diverging
// rather than sequential.
const VOLT_LOW = [227, 73, 72];
const VOLT_MID = [240, 239, 236];
const VOLT_HIGH = [42, 120, 214];
const VOLT_SPAN = 0.06;   // pu deviation that saturates the scale

const CRITICAL = '#d03b3b';

const mix = (a, b, t) => a.map((channel, i) => Math.round(channel + (b[i] - channel) * t));
const rgb = ([r, g, b]) => `rgb(${r} ${g} ${b})`;

function voltageRgb(vm) {
  const t = Math.max(-1, Math.min(1, (vm - 1) / VOLT_SPAN));
  return t < 0 ? mix(VOLT_MID, VOLT_LOW, -t) : mix(VOLT_MID, VOLT_HIGH, t);
}

export function voltageColour(vm) {
  return rgb(voltageRgb(vm));
}

/** Perceived lightness, for deciding what colour the bus number has to be. */
const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/** Loading reads as weight and darkness; an overload switches to the alarm colour. */
export function loadingColour(loading) {
  if (loading > 1) return CRITICAL;
  const t = Math.max(0, Math.min(1, loading));
  return rgb(mix([148, 163, 184], [15, 32, 62], t));
}

export const loadingWidth = loading => 2.2 + Math.min(1.15, Math.max(0, loading)) * 4.6;

const pct = value => `${Math.round(value * 100)}%`;
const pu = value => value.toFixed(3);
const mw = value => `${value.toFixed(1)} MW`;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgEl(tag, attributes = {}, text) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
  if (text !== undefined) node.textContent = text;
  return node;
}

const state = {
  net: null,
  tripped: null,     // branch index, or null for the intact network
  loadScale: 1,
  hovered: null
};

const nodes = {};    // long-lived DOM the redraw writes into

/* ---------------------------------------------------------------- *
 * Diagram
 * ---------------------------------------------------------------- */

function buildDiagram() {
  const svg = svgEl('svg', {
    class: 'cx-diagram',
    viewBox: `0 0 ${VIEW.width} ${VIEW.height}`,
    role: 'group',
    'aria-label': 'One-line diagram of the IEEE 14-bus system. Select a line to trip it.'
  });

  const branchLayer = svgEl('g', { class: 'cx-branches' });
  const busLayer = svgEl('g', { class: 'cx-buses' });
  svg.append(branchLayer, busLayer);

  nodes.branchShapes = state.net.branch.map((branch, index) => {
    const a = LAYOUT[branch.from];
    const b = LAYOUT[branch.to];

    const group = svgEl('g', {
      class: 'cx-branch',
      tabindex: '0',
      role: 'button',
      'data-index': String(index)
    });

    // A fat invisible line under the visible one, so the click target is finger
    // sized without drawing a fat line.
    const hit = svgEl('line', {
      class: 'cx-branch__hit', x1: a.x, y1: a.y, x2: b.x, y2: b.y
    });
    const line = svgEl('line', {
      class: 'cx-branch__line', x1: a.x, y1: a.y, x2: b.x, y2: b.y
    });
    group.append(hit, line);

    // Transformers carry the usual two-circle symbol at the midpoint.
    let symbol = null;
    if (branch.ratio) {
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const along = Math.atan2(b.y - a.y, b.x - a.x);
      const offset = 7;
      symbol = svgEl('g', { class: 'cx-branch__tx' });
      symbol.append(
        svgEl('circle', { cx: mx - Math.cos(along) * offset, cy: my - Math.sin(along) * offset, r: 9 }),
        svgEl('circle', { cx: mx + Math.cos(along) * offset, cy: my + Math.sin(along) * offset, r: 9 })
      );
      group.append(symbol);
    }

    const label = svgEl('title');
    group.append(label);

    const trip = () => {
      state.tripped = state.tripped === index ? null : index;
      redraw();
    };
    group.addEventListener('click', trip);
    group.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        trip();
      }
    });
    group.addEventListener('pointerenter', () => { state.hovered = index; paintHover(); });
    group.addEventListener('pointerleave', () => { state.hovered = null; paintHover(); });
    group.addEventListener('focus', () => { state.hovered = index; paintHover(); });
    group.addEventListener('blur', () => { state.hovered = null; paintHover(); });

    branchLayer.append(group);
    return { group, line, symbol, label };
  });

  nodes.busShapes = state.net.bus.map(bus => {
    const at = LAYOUT[bus.id];
    const group = svgEl('g', { class: 'cx-bus' });

    const generator = state.net.gen.some(gen => gen.bus === bus.id);
    if (generator) {
      // Generator symbol: the circle with a G, offset above the bus.
      const gx = at.x;
      const gy = at.y - 40;
      group.append(svgEl('line', { class: 'cx-bus__stub', x1: at.x, y1: at.y, x2: gx, y2: gy + 13 }));
      group.append(svgEl('circle', { class: 'cx-bus__gen', cx: gx, cy: gy, r: 13 }));
      group.append(svgEl('text', {
        class: 'cx-bus__genmark', x: gx, y: gy, 'text-anchor': 'middle', 'dominant-baseline': 'central'
      }, 'G'));
    }

    const disc = svgEl('circle', { class: 'cx-bus__disc', cx: at.x, cy: at.y, r: BUS_R });
    const number = svgEl('text', {
      class: 'cx-bus__number', x: at.x, y: at.y, 'text-anchor': 'middle', 'dominant-baseline': 'central'
    }, String(bus.id));
    const reading = svgEl('text', {
      class: 'cx-bus__reading', x: at.x, y: at.y + BUS_R + 15, 'text-anchor': 'middle'
    }, '');
    const caption = svgEl('title');

    group.append(disc, number, reading, caption);
    busLayer.append(group);
    return { group, disc, number, reading, caption, id: bus.id };
  });

  return svg;
}

function paintHover() {
  nodes.branchShapes.forEach(({ group }, index) => {
    group.classList.toggle('is-hovered', state.hovered === index);
  });
}

/* ---------------------------------------------------------------- *
 * Panels
 * ---------------------------------------------------------------- */

function buildControls() {
  const bar = element('div', 'cx-controls');

  const loadField = element('div', 'cx-control');
  const loadLabel = element('label', 'cx-control__label', 'System load');
  loadLabel.htmlFor = 'cxLoad';
  const slider = document.createElement('input');
  Object.assign(slider, { type: 'range', id: 'cxLoad', min: '70', max: '130', step: '1', value: '100' });
  slider.className = 'cx-slider';
  const readout = element('output', 'cx-control__value', '100%');
  readout.htmlFor = 'cxLoad';

  // Redraw at most once a frame: the slider fires far faster than twenty-one
  // power flows and a repaint are worth running.
  let queued = false;
  slider.addEventListener('input', () => {
    state.loadScale = Number(slider.value) / 100;
    readout.textContent = `${slider.value}%`;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; redraw(); });
  });

  loadField.append(loadLabel, slider, readout);
  bar.append(loadField);

  const reset = element('button', 'cx-reset', 'Restore all lines');
  reset.type = 'button';
  reset.addEventListener('click', () => {
    state.tripped = null;
    state.loadScale = 1;
    slider.value = '100';
    readout.textContent = '100%';
    redraw();
  });
  bar.append(reset);

  nodes.reset = reset;
  return bar;
}

function describeOutage(index) {
  if (index === null) return 'All lines in service';
  const branch = state.net.branch[index];
  return `Line ${branch.from}–${branch.to} out`;
}

function renderSummary(result, found) {
  const panel = nodes.summary;
  panel.replaceChildren();

  const banner = element('div', 'cx-banner');
  banner.dataset.level = result.islanded ? 'critical'
    : !result.converged ? 'critical'
    : found.count ? 'serious' : 'good';

  banner.append(element('p', 'cx-banner__title', describeOutage(state.tripped)));

  let verdict;
  if (result.islanded) {
    verdict = `Splits the network — bus ${result.stranded.join(', ')} is left with no path to the rest of the system, so there is no power flow to solve.`;
  } else if (!result.converged) {
    verdict = 'The power flow did not converge. At this loading the network has no steady state the solver can find — in practice, voltage collapse.';
  } else if (found.count === 0) {
    verdict = 'Secure: every bus is inside its voltage band and no circuit is above its rating.';
  } else {
    const parts = [];
    if (found.overload.length) parts.push(`${found.overload.length} circuit${found.overload.length > 1 ? 's' : ''} over rating`);
    if (found.voltage.length) parts.push(`${found.voltage.length} bus${found.voltage.length > 1 ? 'es' : ''} outside the voltage band`);
    verdict = `${parts.join(' and ')}.`;
  }
  banner.append(element('p', 'cx-banner__verdict', verdict));
  panel.append(banner);

  if (result.converged) {
    const stats = element('dl', 'cx-stats');
    const stat = (term, value) => {
      const cell = element('div', 'cx-stat');
      cell.append(element('dt', null, term), element('dd', null, value));
      stats.append(cell);
    };
    const worst = result.branches.filter(f => !f.out && f.rating);
    const peak = worst.reduce((max, f) => (f.loading > max.loading ? f : max), worst[0]);

    stat('Load served', mw(result.loadMw));
    stat('Network losses', mw(result.lossesMw));
    stat('Busiest circuit', `${peak.from}–${peak.to} at ${pct(peak.loading)}`);
    panel.append(stats);
  }

  if (found.count) {
    const list = element('ul', 'cx-violations');
    found.overload.forEach(item => {
      const row = element('li');
      row.append(element('span', 'cx-violations__tag', 'Overload'));
      row.append(element('span', null, `Line ${item.from}–${item.to} at ${pct(item.loading)} of rating`));
      list.append(row);
    });
    found.voltage.forEach(item => {
      const row = element('li');
      row.append(element('span', 'cx-violations__tag', item.kind === 'low' ? 'Low volts' : 'High volts'));
      row.append(element('span', null, `Bus ${item.id} at ${pu(item.vm)} pu, limit ${pu(item.limit)}`));
      list.append(row);
    });
    panel.append(list);
  }
}

function renderScreen(ranked) {
  const panel = nodes.screen;
  panel.replaceChildren();

  const head = element('div', 'cx-screen__head');
  head.append(element('h2', null, 'Every single-line outage, ranked'));
  head.append(element('p', 'cx-screen__note',
    'Severity is the active-power performance index. Select a row to apply that outage.'));
  panel.append(head);

  // Does the index actually order these correctly? Compare its ranking against
  // ground truth - whether the outage really does overload something.
  const solvable = ranked.filter(entry => !entry.islanded);
  const lastHarmful = solvable.reduce(
    (last, entry, i) => (entry.violations.overload.length ? i : last), -1);
  const firstClean = solvable.findIndex(entry => entry.violations.overload.length === 0);
  const masked = firstClean >= 0 && lastHarmful > firstClean;

  if (masked) {
    const harmful = solvable[lastHarmful];
    const clean = solvable[firstClean];
    const alert = element('p', 'cx-masking');
    alert.append(element('strong', null, 'The index has the order wrong here. '));
    alert.append(document.createTextNode(
      `Losing ${harmful.from}–${harmful.to} overloads a circuit but ranks ${lastHarmful + 1}, ` +
      `below ${clean.from}–${clean.to} at ${firstClean + 1}, which overloads nothing. ` +
      'A spread of mid-loaded circuits out-scores a single genuine overload — this is masking, ' +
      'and a screen that does it will hand the operator the wrong shortlist.'));
    panel.append(alert);
  }

  const wrap = element('div', 'cx-tablewrap');
  const table = element('table', 'cx-table');

  const headRow = element('tr');
  ['Rank', 'Outage', 'Severity', 'Busiest circuit', 'Result'].forEach((label, i) => {
    const cell = element('th', i >= 2 && i <= 3 ? 'is-numeric' : null, label);
    cell.setAttribute('scope', 'col');
    headRow.append(cell);
  });
  const thead = element('thead');
  thead.append(headRow);
  table.append(thead);

  const body = element('tbody');
  ranked.forEach((entry, i) => {
    const row = element('tr', 'cx-table__row');
    row.tabIndex = 0;
    if (entry.index === state.tripped) row.classList.add('is-applied');

    const apply = () => {
      state.tripped = entry.index;
      redraw();
      nodes.diagramWrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    row.addEventListener('click', apply);
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); apply(); }
    });

    row.append(element('td', null, String(i + 1)));

    const name = element('td', null,
      `${entry.from}–${entry.to}${entry.isTransformer ? ' (transformer)' : ''}`);
    row.append(name);

    row.append(element('td', 'is-numeric',
      entry.islanded || !entry.converged ? '—' : entry.pi.toFixed(2)));
    row.append(element('td', 'is-numeric',
      entry.islanded || !entry.converged ? '—' : pct(entry.worstLoading)));

    const outcome = element('td');
    const tag = element('span', 'cx-tag');
    if (entry.islanded) {
      tag.dataset.level = 'critical';
      tag.textContent = `Islands bus ${entry.stranded.join(', ')}`;
    } else if (!entry.converged) {
      tag.dataset.level = 'critical';
      tag.textContent = 'No solution';
    } else if (entry.violations.overload.length) {
      tag.dataset.level = 'serious';
      tag.textContent = `${entry.violations.overload.length} overload${entry.violations.overload.length > 1 ? 's' : ''}`;
    } else if (entry.violations.voltage.length) {
      tag.dataset.level = 'warning';
      tag.textContent = `${entry.violations.voltage.length} voltage`;
    } else {
      tag.dataset.level = 'good';
      tag.textContent = 'Secure';
    }
    outcome.append(tag);
    row.append(outcome);

    body.append(row);
  });
  table.append(body);
  wrap.append(table);
  panel.append(wrap);
}

function renderLegend() {
  const legend = element('div', 'cx-legend');

  const loading = element('div', 'cx-legend__group');
  loading.append(element('p', 'cx-legend__title', 'Circuit loading'));
  const ramp = element('div', 'cx-legend__ramp');
  [0, 0.25, 0.5, 0.75, 1].forEach(value => {
    const step = element('span', 'cx-legend__step');
    step.style.background = loadingColour(value);
    step.style.height = `${loadingWidth(value)}px`;
    ramp.append(step);
  });
  const over = element('span', 'cx-legend__step cx-legend__step--over');
  over.style.background = CRITICAL;
  over.style.height = `${loadingWidth(1.15)}px`;
  ramp.append(over);
  loading.append(ramp);
  const scale = element('p', 'cx-legend__scale');
  scale.append(element('span', null, '0%'), element('span', null, 'rating'), element('span', null, 'over'));
  loading.append(scale);

  const volts = element('div', 'cx-legend__group');
  volts.append(element('p', 'cx-legend__title', 'Bus voltage'));
  const band = element('div', 'cx-legend__band');
  for (let i = 0; i <= 20; i++) band.append(
    Object.assign(document.createElement('span'), {
      style: `background:${voltageColour(0.94 + (i / 20) * 0.16)}`
    }));
  volts.append(band);
  const vscale = element('p', 'cx-legend__scale');
  vscale.append(element('span', null, '0.94'), element('span', null, '1.00 pu'), element('span', null, '1.10'));
  volts.append(vscale);

  legend.append(loading, volts);
  return legend;
}

/* ---------------------------------------------------------------- *
 * Redraw
 * ---------------------------------------------------------------- */

function redraw() {
  const result = solvePowerFlow(state.net, { outage: state.tripped, loadScale: state.loadScale });
  const found = violations(result);

  state.net.branch.forEach((branch, index) => {
    const shape = nodes.branchShapes[index];
    const flow = result.converged ? result.branches[index] : null;
    const isOut = index === state.tripped;

    shape.group.classList.toggle('is-out', isOut);
    shape.group.setAttribute('aria-label',
      `Line ${branch.from} to ${branch.to}${isOut ? ', out of service' : ''}. ` +
      (flow && !flow.out ? `Carrying ${flow.mva.toFixed(1)} of ${flow.rating} MVA.` : '') +
      ` Select to ${isOut ? 'restore' : 'trip'}.`);

    if (isOut || !flow || flow.out) {
      shape.line.setAttribute('stroke', '#c8d2e4');
      shape.line.setAttribute('stroke-width', '2.2');
      shape.label.textContent = `Line ${branch.from}–${branch.to} — out of service`;
    } else {
      shape.line.setAttribute('stroke', loadingColour(flow.loading));
      shape.line.setAttribute('stroke-width', String(loadingWidth(flow.loading)));
      shape.group.classList.toggle('is-over', flow.loading > 1);
      shape.label.textContent =
        `Line ${branch.from}–${branch.to}: ${flow.mva.toFixed(1)} MVA of ${flow.rating} ` +
        `(${pct(flow.loading)})`;
    }
    if (isOut) shape.group.classList.remove('is-over');
  });

  const outOfBand = new Map(found.voltage.map(item => [item.id, item]));
  nodes.busShapes.forEach(shape => {
    const bus = result.converged ? result.buses.find(b => b.id === shape.id) : null;
    if (!bus) {
      shape.disc.setAttribute('fill', '#eef1f6');
      shape.reading.textContent = '';
      shape.group.classList.remove('is-violating');
      shape.caption.textContent = `Bus ${shape.id} — no solution`;
      return;
    }
    // The fill runs from pale neutral to saturated red or blue, so the bus
    // number has to flip to white over the dark end of either arm.
    const fill = voltageRgb(bus.vm);
    const onDark = luminance(fill) < 0.55;
    shape.disc.setAttribute('fill', rgb(fill));
    shape.number.style.fill = onDark ? '#ffffff' : '';
    shape.number.style.stroke = onDark ? 'rgba(9,24,54,.55)' : '';
    shape.reading.textContent = pu(bus.vm);
    shape.group.classList.toggle('is-violating', outOfBand.has(shape.id));
    shape.caption.textContent =
      `Bus ${shape.id}: ${pu(bus.vm)} pu, ${bus.va.toFixed(1)}°`;
  });

  renderSummary(result, found);
  renderScreen(screenContingencies(state.net, { loadScale: state.loadScale }));
  nodes.reset.disabled = state.tripped === null && state.loadScale === 1;
}

/* ---------------------------------------------------------------- *
 * Boot
 * ---------------------------------------------------------------- */

async function init() {
  const root = document.getElementById('cx');
  if (!root) return;

  try {
    const response = await fetch(CASE_URL, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`case data answered ${response.status}`);
    state.net = await response.json();
  } catch (error) {
    console.warn('Contingency demo unavailable:', error.message);
    root.replaceChildren(element('p', 'cx__status', 'The network data could not be loaded.'));
    return;
  }

  root.replaceChildren();
  root.append(buildControls());

  const board = element('div', 'cx-board');
  nodes.diagramWrap = element('div', 'cx-diagramwrap');
  // Below a certain width the diagram would shrink to unreadable, untappable
  // bus discs, so on a phone it scrolls at a usable size instead.
  const scroller = element('div', 'cx-diagramscroll');
  scroller.append(buildDiagram());
  nodes.diagramWrap.append(scroller, renderLegend());
  nodes.summary = element('div', 'cx-summary');
  board.append(nodes.diagramWrap, nodes.summary);
  root.append(board);

  nodes.screen = element('div', 'cx-screen');
  root.append(nodes.screen);

  redraw();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
