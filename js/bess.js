// js/bess.js
//
// "Where should the battery go?" - the storage-siting demonstration.
//
// The feeder is a published test case with fixed impedances. Everything driving
// it is live: regional carbon intensity and generation mix from the National
// Energy System Operator's carbon API, GB demand and the half-hourly system
// price from Elexon. The visitor picks a licence area, a node, a size and a
// dispatch rule; the page solves the feeder ninety-six times and says whether
// the siting works and what it is worth.
//
// The physics and the accounting are in lib/battery.js and lib/powerflow.js and
// are tested separately. This file is the drawing and the wiring.

import {
  MODES,
  REGIONS,
  ROUND_TRIP,
  SLOTS,
  assess,
  baseline,
  fmtGbp,
  scheduleBattery,
  value,
  verdict
} from './lib/battery.js';

const CASE_URL = '/data/feeder33.json';

const API_CARBON = 'https://api.carbonintensity.org.uk/regional/intensity';
const API_DEMAND = 'https://data.elexon.co.uk/bmrs/api/v1/demand/outturn/summary?format=json';
const API_PRICE = 'https://data.elexon.co.uk/bmrs/api/v1/balancing/settlement/system-prices';

const REQUEST_TIMEOUT_MS = 9000;
const REFRESH_MS = 15 * 60 * 1000;
const HALF_HOUR_MS = 30 * 60 * 1000;

/**
 * Hand-placed layout. The trunk runs left to right with its three laterals
 * hanging off buses 2, 3 and 6, arranged so no two branches cross - the same
 * rule the 14-bus diagram follows.
 */
const LAYOUT = (() => {
  const places = {};
  for (let id = 1; id <= 18; id++) places[id] = { x: 42 + (id - 1) * 49, y: 212 };
  [23, 24, 25].forEach((id, i) => { places[id] = { x: 176 + i * 55, y: 96 }; });
  [19, 20, 21, 22].forEach((id, i) => { places[id] = { x: 122 + i * 55, y: 324 }; });
  [26, 27, 28, 29, 30, 31, 32, 33].forEach((id, i) => { places[id] = { x: 342 + i * 55, y: 436 }; });
  return places;
})();

const VIEW = { width: 940, height: 500 };
const BUS_R = 13;

// The same diverging voltage scale as the 14-bus page - red below nominal,
// neutral at 1.00 pu, blue above - so a colour means the same thing across both
// demonstrations. The span is wider here because a distribution feeder droops
// much further than a transmission network: at the 0.06 pu used on the 14-bus
// page everything past bus 14 would clip to the same saturated red, losing the
// gradient exactly where the interesting part of this feeder lives. A genuine
// limit breach is carried by the red outline, not by the fill.
const VOLT_LOW = [227, 73, 72];
const VOLT_MID = [240, 239, 236];
const VOLT_HIGH = [42, 120, 214];
const VOLT_SPAN = 0.09;
const CRITICAL = '#d03b3b';

const mix = (a, b, t) => a.map((channel, i) => Math.round(channel + (b[i] - channel) * t));
const rgb = ([r, g, b]) => `rgb(${r} ${g} ${b})`;

function voltageRgb(vm) {
  const t = Math.max(-1, Math.min(1, (vm - 1) / VOLT_SPAN));
  return t < 0 ? mix(VOLT_MID, VOLT_LOW, -t) : mix(VOLT_MID, VOLT_HIGH, t);
}

export const voltageColour = vm => rgb(voltageRgb(vm));
const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

const svg = (tag, attrs = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([key, v]) => node.setAttribute(key, v));
  return node;
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/* ------------------------------------------------------------------ *
 * Live data
 * ------------------------------------------------------------------ */

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** The 48 half-hour boundaries ending with the one we are currently inside. */
export function slotStarts(now = Date.now()) {
  const current = Math.floor(now / HALF_HOUR_MS) * HALF_HOUR_MS;
  return Array.from({ length: SLOTS }, (_, i) => current - (SLOTS - 1 - i) * HALF_HOUR_MS);
}

/**
 * Drop a set of timestamped readings onto those 48 slots, then fill any hole
 * from its nearest neighbour. The three feeds publish on different cadences and
 * none of them is guaranteed complete, so a gap has to degrade rather than
 * produce a hole in the middle of a power flow.
 */
export function align(records, starts) {
  const buckets = starts.map(() => []);
  const first = starts[0];

  records.forEach(({ t, v }) => {
    if (!Number.isFinite(v)) return;
    const i = Math.floor((t - first) / HALF_HOUR_MS);
    if (i >= 0 && i < starts.length) buckets[i].push(v);
  });

  const series = buckets.map(hits => (hits.length ? hits.reduce((a, b) => a + b, 0) / hits.length : null));
  if (series.every(v => v === null)) return null;

  for (let i = 1; i < series.length; i++) if (series[i] === null) series[i] = series[i - 1];
  for (let i = series.length - 2; i >= 0; i--) if (series[i] === null) series[i] = series[i + 1];
  return series;
}

async function fetchCarbon(regionId, starts) {
  // An explicit from/to range, not the pt24h shorthand: pt24h returns the day
  // *before* the timestamp it is given, which is a whole window out of step.
  const stamp = ms => new Date(ms).toISOString().slice(0, 16) + 'Z';
  const from = stamp(starts[0]);
  const to = stamp(starts[SLOTS - 1] + HALF_HOUR_MS);
  const payload = await getJson(`${API_CARBON}/${from}/${to}/regionid/${regionId}`);
  const rows = payload?.data?.data ?? [];
  const series = align(
    rows.map(row => ({ t: Date.parse(row.from), v: row.intensity?.forecast })),
    starts
  );
  const latest = rows[rows.length - 1];
  return {
    series,
    mix: latest?.generationmix ?? [],
    shortname: payload?.data?.shortname,
    dno: payload?.data?.dnoregion
  };
}

async function fetchDemand(starts) {
  const rows = await getJson(API_DEMAND);
  return align(
    (Array.isArray(rows) ? rows : []).map(row => ({ t: Date.parse(row.startTime), v: row.demand })),
    starts
  );
}

async function fetchPrice(starts) {
  const day = ms => new Date(ms).toISOString().slice(0, 10);
  const days = [...new Set([day(starts[0]), day(starts[SLOTS - 1])])];
  const payloads = await Promise.all(days.map(d => getJson(`${API_PRICE}/${d}?format=json`)));
  const rows = payloads.flatMap(payload => payload?.data ?? []);
  return align(
    rows.map(row => ({ t: Date.parse(row.startTime), v: row.systemSellPrice })),
    starts
  );
}

/**
 * A stand-in for any feed that does not answer, so one dead endpoint does not
 * take the page down. Every readout derived from a fallback is labelled as one:
 * the point of the page is that the numbers are live, and a silent substitution
 * would be worse than an outage.
 */
function fallback(kind, starts) {
  return starts.map(t => {
    const hour = new Date(t).getUTCHours() + new Date(t).getUTCMinutes() / 60;
    const evening = Math.max(0, Math.sin(((hour - 6) / 24) * 2 * Math.PI));
    if (kind === 'demand') return 24000 + 11000 * evening;
    if (kind === 'price') return 45 + 110 * Math.pow(0.65 + 0.35 * evening, 4);
    return 90 + 160 * Math.pow(0.6 + 0.4 * evening, 2);
  });
}

async function loadWindow(regionId) {
  const starts = slotStarts();
  const [carbon, demand, price] = await Promise.allSettled([
    fetchCarbon(regionId, starts),
    fetchDemand(starts),
    fetchPrice(starts)
  ]);

  const stale = [];
  const carbonOk = carbon.status === 'fulfilled' && carbon.value.series;
  const demandOk = demand.status === 'fulfilled' && demand.value;
  const priceOk = price.status === 'fulfilled' && price.value;

  if (!carbonOk) stale.push('carbon intensity');
  if (!demandOk) stale.push('demand');
  if (!priceOk) stale.push('price');

  const demandSeries = demandOk ? demand.value : fallback('demand', starts);
  const peak = Math.max(...demandSeries);

  return {
    starts,
    carbon: carbonOk ? carbon.value.series : fallback('carbon', starts),
    price: priceOk ? price.value : fallback('price', starts),
    demand: demandSeries,
    // No per-node measurement exists for any GB feeder, so the case's published
    // nodal loads are scaled by GB demand against the highest half-hour in this
    // window. Stated on the page, because it is the one thing here that is not
    // a measurement.
    demandScale: demandSeries.map(mw => mw / peak),
    mix: carbonOk ? carbon.value.mix : [],
    regionName: carbonOk ? carbon.value.shortname : null,
    dno: carbonOk ? carbon.value.dno : null,
    stale
  };
}

/* ------------------------------------------------------------------ *
 * Page state
 * ------------------------------------------------------------------ */

const state = {
  net: null,
  live: null,
  baseSeries: null,
  regionId: 14,
  bus: 18,
  powerMw: 0.45,
  energyMwh: 2.25,
  mode: 'network',
  result: null,
  hovered: null
};

const fmt = (value, digits = 0) =>
  Number(value).toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });

const signed = (value, digits = 0) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${fmt(Math.abs(value), digits)}`;

function recompute() {
  const { net, live } = state;
  const schedule = scheduleBattery({
    price: live.price,
    carbon: live.carbon,
    demand: live.demand,
    powerMw: state.powerMw,
    energyMwh: state.energyMwh,
    mode: state.mode
  });

  const assessment = assess(net, {
    bus: state.bus,
    setpoints: schedule.setpoints,
    demandScale: live.demandScale,
    baseSeries: state.baseSeries
  });

  const worth = value({
    assessment,
    setpoints: schedule.setpoints,
    price: live.price,
    carbon: live.carbon,
    energyMwh: state.energyMwh
  });

  state.result = {
    schedule,
    assessment,
    worth,
    call: verdict({ assessment, worth, net, setpoints: schedule.setpoints })
  };
}

/* ------------------------------------------------------------------ *
 * The one-line diagram
 * ------------------------------------------------------------------ */

function buildDiagram(root) {
  const wrap = el('div', 'bx-diagramwrap');
  const board = svg('svg', {
    class: 'bx-diagram',
    viewBox: `0 0 ${VIEW.width} ${VIEW.height}`,
    role: 'img',
    'aria-label': 'One-line diagram of the 33-bus distribution feeder. Select a bus to place the battery.'
  });

  const branchLayer = svg('g');
  const busLayer = svg('g');
  board.append(branchLayer, busLayer);
  wrap.append(board);
  root.append(wrap);
  return { board, branchLayer, busLayer };
}

function drawDiagram(layers, slot) {
  const { branchLayer, busLayer } = layers;
  const { net, result } = state;
  branchLayer.replaceChildren();
  busLayer.replaceChildren();

  const snap = result.assessment.series.withBattery[slot];
  const flows = snap.result.branches;
  const busVm = new Map(snap.result.buses.map(bus => [bus.id, bus.vm]));

  net.branch.forEach((branch, i) => {
    const a = LAYOUT[branch.from];
    const b = LAYOUT[branch.to];
    const flow = flows[i];
    const loading = flow.loading ?? 0;
    const over = loading > 1;

    branchLayer.append(svg('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      stroke: over ? CRITICAL : '#8f9bb0',
      'stroke-width': 2 + Math.min(loading, 1.4) * 6,
      'stroke-linecap': 'round',
      opacity: over ? 1 : 0.55 + Math.min(loading, 1) * 0.35
    }));
  });

  net.bus.forEach(bus => {
    const at = LAYOUT[bus.id];
    const vm = busVm.get(bus.id) ?? 1;
    const outOfBand = vm < bus.vmin - 1e-9 || vm > bus.vmax + 1e-9;
    const isSource = bus.id === net.bus[0].id;
    const chosen = bus.id === state.bus;

    const group = svg('g', {
      class: `bx-bus${isSource ? ' bx-bus--source' : ''}${chosen ? ' bx-bus--chosen' : ''}`,
      tabindex: isSource ? '-1' : '0',
      role: isSource ? 'presentation' : 'button',
      'aria-label': isSource
        ? 'Primary substation'
        : `Bus ${bus.id}, ${vm.toFixed(3)} per unit. Place the battery here.`,
      'aria-pressed': isSource ? null : String(chosen)
    });

    if (isSource) {
      group.append(svg('rect', {
        x: at.x - 17, y: at.y - 17, width: 34, height: 34, rx: 5,
        fill: '#0a1a3b', stroke: '#0a1a3b', 'stroke-width': 2
      }));
      const mark = svg('text', {
        x: at.x, y: at.y + 4, 'text-anchor': 'middle', class: 'bx-buslabel', fill: '#fff'
      });
      mark.textContent = 'S';
      group.append(mark);
    } else {
      const fill = voltageRgb(vm);
      group.append(svg('circle', {
        cx: at.x, cy: at.y, r: chosen ? BUS_R + 3 : BUS_R,
        fill: rgb(fill),
        stroke: outOfBand ? CRITICAL : chosen ? '#0f66ff' : '#33415c',
        'stroke-width': outOfBand ? 3 : chosen ? 3 : 1.2
      }));
      const label = svg('text', {
        x: at.x, y: at.y + 4, 'text-anchor': 'middle', class: 'bx-buslabel',
        fill: luminance(fill) > 0.55 ? '#0a1a3b' : '#fff'
      });
      label.textContent = String(bus.id);
      group.append(label);

      const place = () => { state.bus = bus.id; render(); };
      group.addEventListener('click', place);
      group.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); place(); }
      });
    }

    busLayer.append(group);
  });

  // The battery, drawn on top of whichever bus holds it.
  const at = LAYOUT[state.bus];
  const mw = result.schedule.setpoints[slot];
  const charging = mw < -1e-9;
  const idle = Math.abs(mw) <= 1e-9;

  const badge = svg('g', { class: 'bx-battery' });
  badge.append(svg('rect', {
    x: at.x - 22, y: at.y - 42, width: 44, height: 22, rx: 5,
    fill: idle ? '#8f9bb0' : charging ? '#b4553f' : '#0f66ff',
    stroke: '#fff', 'stroke-width': 2
  }));
  const text = svg('text', { x: at.x, y: at.y - 27, 'text-anchor': 'middle', class: 'bx-batterylabel' });
  text.textContent = idle ? 'idle' : `${charging ? '−' : '+'}${Math.abs(mw).toFixed(2)}`;
  badge.append(text);
  badge.append(svg('line', {
    x1: at.x, y1: at.y - 20, x2: at.x, y2: at.y - BUS_R - 2,
    stroke: '#33415c', 'stroke-width': 2
  }));
  busLayer.append(badge);
}

/* ------------------------------------------------------------------ *
 * The 24-hour strip
 * ------------------------------------------------------------------ */

function drawStrip(host, slot) {
  const { live, result } = state;
  const W = 940;
  const H = 150;
  const padL = 4;
  const padR = 4;
  const mid = 96;

  host.replaceChildren();
  const board = svg('svg', {
    class: 'bx-strip', viewBox: `0 0 ${W} ${H}`, role: 'img',
    'aria-label': 'The last 24 hours: feeder demand, battery setpoint and regional carbon intensity.'
  });

  const x = i => padL + (i * (W - padL - padR)) / (SLOTS - 1);
  const band = (series, top, height) => {
    const lo = Math.min(...series);
    const hi = Math.max(...series);
    const span = hi - lo || 1;
    return i => top + height - ((series[i] - lo) / span) * height;
  };

  const demandY = band(live.demandScale, 8, 54);
  const carbonY = band(live.carbon, 8, 54);

  // Demand and carbon intensity, both normalised - the shapes are the point,
  // not the levels, and the levels are printed as numbers below.
  const path = (yOf, stroke, dash) => {
    let d = '';
    for (let i = 0; i < SLOTS; i++) d += `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yOf(i).toFixed(1)}`;
    board.append(svg('path', {
      d, fill: 'none', stroke, 'stroke-width': 2, 'stroke-linejoin': 'round',
      ...(dash ? { 'stroke-dasharray': dash } : {})
    }));
  };
  path(demandY, '#33415c');
  path(carbonY, '#2e9e6b', '5 4');

  // Battery setpoint, as bars either side of a zero line.
  const peakMw = Math.max(state.powerMw, 0.01);
  const barH = 42;
  board.append(svg('line', { x1: padL, y1: mid + barH, x2: W - padR, y2: mid + barH, stroke: '#c9d3e4', 'stroke-width': 1 }));

  for (let i = 0; i < SLOTS; i++) {
    const mw = result.schedule.setpoints[i];
    if (Math.abs(mw) < 1e-9) continue;
    const height = (Math.abs(mw) / peakMw) * barH;
    board.append(svg('rect', {
      x: x(i) - 7, y: mw > 0 ? mid + barH - height : mid + barH,
      width: 14, height: Math.max(1, height),
      fill: mw > 0 ? '#0f66ff' : '#b4553f', opacity: 0.85, rx: 1.5
    }));
  }

  board.append(svg('rect', {
    x: x(slot) - 8, y: 4, width: 16, height: H - 8,
    fill: '#0f66ff', opacity: 0.1, rx: 3
  }));

  host.append(board);
}

/* ------------------------------------------------------------------ *
 * Readouts
 * ------------------------------------------------------------------ */

function statCard(label, value, note) {
  const card = el('div', 'bx-stat');
  card.append(el('p', 'bx-stat__label', label));
  card.append(el('p', 'bx-stat__value', value));
  if (note) card.append(el('p', 'bx-stat__note', note));
  return card;
}

function renderVerdict(host) {
  const { call, assessment, worth } = state.result;
  host.replaceChildren();
  host.className = `bx-verdict bx-verdict--${call.level}`;

  host.append(el('p', 'bx-verdict__binding', `Binding constraint: ${call.binding}`));
  host.append(el('h3', 'bx-verdict__headline', call.headline));
  host.append(el('p', 'bx-verdict__reason', call.reason));

  const grid = el('div', 'bx-stats');
  const before = assessment.base;
  const after = assessment.withBattery;

  grid.append(statCard(
    'Lowest voltage, worst half-hour',
    `${after.vmin.toFixed(3)} pu`,
    `was ${before.vmin.toFixed(3)} pu at bus ${before.vminBus} — limit ${state.net.bus[1].vmin}`
  ));
  grid.append(statCard(
    'Lowest voltage at demand peak',
    `${assessment.atPeak.withBattery.toFixed(3)} pu`,
    `was ${assessment.atPeak.base.toFixed(3)} pu`
  ));
  grid.append(statCard(
    'Heaviest circuit',
    `${(after.worstLoading * 100).toFixed(0)}%`,
    `was ${(before.worstLoading * 100).toFixed(0)}% of rating`
  ));
  grid.append(statCard(
    'Half-hours outside the band',
    `${after.voltageBreaches}`,
    `was ${before.voltageBreaches} of ${SLOTS}`
  ));
  grid.append(statCard(
    'Peak import at the primary',
    `${after.peakHeadMw.toFixed(2)} MW`,
    `${signed(-worth.peakReducedMw, 2)} MW against no battery`
  ));
  grid.append(statCard(
    'Feeder losses over 24 h',
    `${(after.lossesMwh * 1000).toFixed(0)} kWh`,
    `${signed(-worth.lossMwhSaved * 1000)} kWh against no battery`
  ));

  host.append(grid);
}

function renderMoney(host) {
  const { worth } = state.result;
  host.replaceChildren();

  host.append(el('h3', 'bx-panel__title', 'What it is worth, and to whom'));
  host.append(el('p', 'bx-panel__lead',
    'Two ledgers, deliberately not added together. In GB a network operator buys flexibility; it does not '
    + 'own batteries and does not trade. A single total would imply a party that does not exist.'));

  const lossKwh = worth.lossMwhSaved * 1000;
  const grid = el('div', 'bx-stats');

  grid.append(statCard(
    lossKwh >= 0 ? 'Network losses removed' : 'Network losses added',
    `${fmt(Math.abs(lossKwh))} kWh`,
    lossKwh >= 0
      ? 'less copper loss on the feeder over 24 hours than with no battery at all'
      : 'more loss than with no battery: it draws current twice, and loss goes as the square of it'
  ));
  grid.append(statCard(
    'Network losses, as money',
    `${fmtGbp(worth.lossValue)} / day`,
    'valued half-hour by half-hour at the live system price. The sign can differ from the energy above, '
    + 'because moving a loss into a cheaper hour is worth something even when the loss itself grows'
  ));
  grid.append(statCard(
    worth.peakReducedMw >= 0 ? 'Peak demand removed' : 'Peak demand added',
    `${Math.abs(worth.peakReducedMw).toFixed(2)} MW`,
    worth.peakReducedMw >= 0
      ? 'at the primary substation — what a case for deferring reinforcement would be argued from'
      : 'at the primary substation. This rule charges into the peak it was meant to relieve'
  ));
  grid.append(statCard(
    'To whoever owns the battery',
    `${fmtGbp(worth.arbitrage)} / day`,
    'buying and selling at the system price. GB storage earns most of its income in the balancing '
    + 'mechanism and ancillary services, none of which is counted here, so read this as a floor'
  ));
  host.append(grid);
}

function renderCarbon(host) {
  const { worth } = state.result;
  const { live } = state;
  host.replaceChildren();

  const net = worth.netOperationalKg;
  const better = net < 0;

  host.append(el('h3', 'bx-panel__title', 'Carbon, in the direction it actually moves'));
  host.append(el('p', 'bx-panel__lead',
    `A battery loses about ${((1 - ROUND_TRIP) * 100).toFixed(0)} per cent of everything it stores. It only `
    + 'reduces emissions if the intensity gap it moves energy across is wider than that loss. Charging adds, '
    + 'discharging avoids, and the two do not have to net out in your favour.'));

  const headline = el('p', `bx-carbon__headline bx-carbon__headline--${better ? 'down' : 'up'}`);
  headline.textContent = better
    ? `Reducing emissions: ${fmt(Math.abs(net))} kg CO₂e avoided over the window`
    : `Increasing emissions: ${fmt(Math.abs(net))} kg CO₂e added over the window`;
  host.append(headline);

  const grid = el('div', 'bx-stats');
  grid.append(statCard(
    'Shifting energy',
    `${signed(worth.operationalKg)} kg`,
    'charged at one intensity, discharged at another'
  ));
  grid.append(statCard(
    'Losses avoided on the feeder',
    `${signed(-worth.lossCarbonKg)} kg`,
    'copper that no longer heats up, at the live regional intensity'
  ));
  grid.append(statCard(
    'Embodied, amortised',
    `${fmt(worth.embodiedKgPerDay.low)}–${fmt(worth.embodiedKgPerDay.high)} kg / day`,
    'manufacture spread over a 15-year life; published factors spread this widely'
  ));
  grid.append(statCard(
    'Same energy from a diesel set',
    `${fmt(worth.dieselKg)} kg`,
    `the ${worth.dischargedMwh.toFixed(2)} MWh discharged, generated at 0.27 kg/kWh instead`
  ));
  host.append(grid);

  if (live.mix.length) {
    const top = [...live.mix].sort((a, b) => b.perc - a.perc).slice(0, 4)
      .filter(fuel => fuel.perc > 0)
      .map(fuel => `${fuel.fuel} ${fuel.perc.toFixed(0)}%`)
      .join(' · ');
    host.append(el('p', 'bx-panel__foot', `Regional mix in the latest half-hour: ${top}.`));
  }
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

function slider({ id, label, min, max, step, get, set, format }) {
  const field = el('div', 'bx-control');
  const head = el('div', 'bx-control__head');
  const name = el('label', 'bx-control__label', label);
  name.setAttribute('for', id);
  const readout = el('span', 'bx-control__value', format(get()));
  head.append(name, readout);

  const input = document.createElement('input');
  Object.assign(input, { type: 'range', id, min, max, step, value: String(get()) });
  input.className = 'bx-slider';

  let queued = false;
  input.addEventListener('input', () => {
    set(Number(input.value));
    readout.textContent = format(get());
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(); });
  });

  field.append(head, input);
  return field;
}

function buildControls(root) {
  const panel = el('div', 'bx-controls');

  const regionField = el('div', 'bx-control');
  const regionHead = el('div', 'bx-control__head');
  const regionLabel = el('label', 'bx-control__label', 'Distribution licence area');
  regionLabel.setAttribute('for', 'bxRegion');
  regionHead.append(regionLabel);
  const select = document.createElement('select');
  select.id = 'bxRegion';
  select.className = 'bx-select';
  REGIONS.forEach(region => {
    const option = document.createElement('option');
    option.value = String(region.id);
    option.textContent = `${region.name} — ${region.dno}`;
    if (region.id === state.regionId) option.selected = true;
    select.append(option);
  });
  select.addEventListener('change', async () => {
    state.regionId = Number(select.value);
    await refresh();
  });
  regionField.append(regionHead, select);
  panel.append(regionField);

  panel.append(slider({
    id: 'bxPower', label: 'Battery power', min: 0.05, max: 1.5, step: 0.05,
    get: () => state.powerMw,
    set: v => { state.powerMw = v; },
    format: v => `${v.toFixed(2)} MW`
  }));

  panel.append(slider({
    id: 'bxEnergy', label: 'Battery energy', min: 0.25, max: 6, step: 0.25,
    get: () => state.energyMwh,
    set: v => { state.energyMwh = v; },
    format: v => `${v.toFixed(2)} MWh · ${(v / Math.max(state.powerMw, 0.01)).toFixed(1)} h`
  }));

  const modeField = el('fieldset', 'bx-control bx-modes');
  modeField.append(el('legend', 'bx-control__label', 'Dispatch rule'));
  Object.entries(MODES).forEach(([key, meta]) => {
    const wrap = el('label', 'bx-mode');
    const input = document.createElement('input');
    Object.assign(input, { type: 'radio', name: 'bxMode', value: key, checked: key === state.mode });
    input.addEventListener('change', () => { state.mode = key; render(); });
    wrap.append(input, el('span', 'bx-mode__label', meta.label), el('span', 'bx-mode__blurb', meta.blurb));
    modeField.append(wrap);
  });
  panel.append(modeField);

  root.append(panel);
  return panel;
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

let dom = null;

function render() {
  recompute();
  const slot = SLOTS - 1;
  drawDiagram(dom.layers, slot);
  drawStrip(dom.strip, slot);
  renderVerdict(dom.verdict);
  renderMoney(dom.money);
  renderCarbon(dom.carbon);
  renderStatus();
}

function renderStatus() {
  const { live } = state;
  const nowCarbon = live.carbon[SLOTS - 1];
  const nowPrice = live.price[SLOTS - 1];
  const nowDemand = live.demand[SLOTS - 1];
  const region = REGIONS.find(r => r.id === state.regionId);
  const stamp = new Date(live.starts[SLOTS - 1]);

  dom.status.replaceChildren();
  const line = el('p', 'bx-status__line');
  line.append(el('strong', null, live.regionName || region.name));
  line.append(document.createTextNode(
    ` · ${Math.round(nowCarbon)} gCO₂/kWh · GB demand ${fmt(nowDemand)} MW `
    + `· system price ${fmtGbp(nowPrice)}/MWh`
  ));
  dom.status.append(line);

  const foot = el('p', 'bx-status__foot');
  foot.textContent = `Half-hour beginning ${stamp.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
    + `, ${stamp.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}. `
    + `Feeder solved ${SLOTS * 2} times for this window.`;
  dom.status.append(foot);

  if (live.stale.length) {
    dom.status.append(el('p', 'bx-status__warn',
      `Live ${live.stale.join(' and ')} did not answer, so a documented stand-in profile is in use for `
      + `${live.stale.length > 1 ? 'those' : 'that'}. Every other number on this page is live.`));
  }
}

async function refresh() {
  dom.status.replaceChildren(el('p', 'bx-status__line', 'Fetching live GB data…'));
  try {
    state.live = await loadWindow(state.regionId);
  } catch (error) {
    dom.status.replaceChildren(el('p', 'bx-status__warn', `Could not reach the live feeds: ${error.message}`));
    return;
  }
  state.baseSeries = baseline(state.net, state.live.demandScale);
  render();
}

async function init() {
  const root = document.getElementById('bx');
  if (!root) return;

  try {
    state.net = await (await fetch(CASE_URL)).json();
  } catch (error) {
    root.replaceChildren(el('p', 'bx-status__warn', 'Could not load the feeder model.'));
    return;
  }

  root.replaceChildren();
  const status = el('div', 'bx-status');
  root.append(status);

  const layers = buildDiagram(root);
  const controls = el('div', 'bx-layout');
  root.append(controls);
  buildControls(controls);

  const strip = el('div', 'bx-stripwrap');
  root.append(el('h3', 'bx-panel__title', 'The last 24 hours'));
  root.append(strip);
  root.append(el('p', 'bx-panel__foot',
    'Solid line: feeder demand. Dashed line: regional carbon intensity. Bars: battery setpoint, '
    + 'blue discharging, red charging. The shaded column is the half-hour drawn above.'));

  const verdictHost = el('div', 'bx-verdict');
  const money = el('div', 'bx-panel');
  const carbon = el('div', 'bx-panel');
  root.append(verdictHost, money, carbon);

  dom = { status, layers, strip, verdict: verdictHost, money, carbon };

  await refresh();
  setInterval(refresh, REFRESH_MS);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
