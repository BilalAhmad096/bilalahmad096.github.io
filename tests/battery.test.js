// tests/battery.test.js
//
// The feeder case and the siting engine. The case is checked against the
// published Baran-Wu solution first: if the impedances are wrong nothing
// downstream means anything.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { solvePowerFlow } from '../js/lib/powerflow.js';
import { settlementDates, slotStarts } from '../js/bess.js';
import {
  DIESEL_KG_PER_KWH,
  HOURS_PER_SLOT,
  REGIONS,
  ROUND_TRIP,
  SLOTS,
  assess,
  baseline,
  fmtGbp,
  headIndex,
  scheduleBattery,
  value,
  verdict,
  withBattery
} from '../js/lib/battery.js';

const net = JSON.parse(readFileSync(new URL('../data/feeder33.json', import.meta.url), 'utf8'));

/** A shaped 24-hour window: an evening demand peak, price tracking it, carbon offset from both. */
function window_() {
  const demand = [];
  const price = [];
  const carbon = [];
  for (let i = 0; i < SLOTS; i++) {
    const h = i / 2;
    const evening = Math.max(0, Math.sin(((h - 6) / 24) * 2 * Math.PI));
    const d = 0.65 + 0.35 * evening;
    demand.push(d);
    price.push(40 + 120 * Math.pow(d, 4));
    carbon.push(60 + 200 * Math.pow(0.65 + 0.35 * Math.max(0, Math.sin(((h - 2) / 24) * 2 * Math.PI)), 3));
  }
  return { demand, price, carbon, demandScale: demand };
}

function run({ bus = 18, powerMw = 0.45, energyMwh = 2.25, mode = 'network' } = {}) {
  const w = window_();
  const schedule = scheduleBattery({ ...w, powerMw, energyMwh, mode });
  const assessment = assess(net, { bus, setpoints: schedule.setpoints, demandScale: w.demandScale });
  const worth = value({ assessment, setpoints: schedule.setpoints, price: w.price, carbon: w.carbon, energyMwh });
  return { w, schedule, assessment, worth, call: verdict({ assessment, worth, net, setpoints: schedule.setpoints }) };
}

/* ---------------- the case itself ---------------- */

/**
 * Baran and Wu (1989) as MATPOWER distributes it in data/case33bw.m: from, to,
 * R and X in ohms, and the P kW and Q kVAr drawn at the receiving bus. Pinned
 * value by value, because the published-solution check below cannot see a
 * transcription slip - X on branch 1-2 once read 0.0477 instead of 0.0470, and
 * the loss moved by 0.005 kW.
 */
const PUBLISHED = [
  [1, 2, 0.0922, 0.0470, 100, 60], [2, 3, 0.4930, 0.2511, 90, 40], [3, 4, 0.3660, 0.1864, 120, 80],
  [4, 5, 0.3811, 0.1941, 60, 30], [5, 6, 0.8190, 0.7070, 60, 20], [6, 7, 0.1872, 0.6188, 200, 100],
  [7, 8, 0.7114, 0.2351, 200, 100], [8, 9, 1.0300, 0.7400, 60, 20], [9, 10, 1.0440, 0.7400, 60, 20],
  [10, 11, 0.1966, 0.0650, 45, 30], [11, 12, 0.3744, 0.1238, 60, 35], [12, 13, 1.4680, 1.1550, 60, 35],
  [13, 14, 0.5416, 0.7129, 120, 80], [14, 15, 0.5910, 0.5260, 60, 10], [15, 16, 0.7463, 0.5450, 60, 20],
  [16, 17, 1.2890, 1.7210, 60, 20], [17, 18, 0.7320, 0.5740, 90, 40], [2, 19, 0.1640, 0.1565, 90, 40],
  [19, 20, 1.5042, 1.3554, 90, 40], [20, 21, 0.4095, 0.4784, 90, 40], [21, 22, 0.7089, 0.9373, 90, 40],
  [3, 23, 0.4512, 0.3083, 90, 50], [23, 24, 0.8980, 0.7091, 420, 200], [24, 25, 0.8960, 0.7011, 420, 200],
  [6, 26, 0.2030, 0.1034, 60, 25], [26, 27, 0.2842, 0.1447, 60, 25], [27, 28, 1.0590, 0.9337, 60, 20],
  [28, 29, 0.8042, 0.7006, 120, 70], [29, 30, 0.5075, 0.2585, 200, 600], [30, 31, 0.9744, 0.9630, 150, 70],
  [31, 32, 0.3105, 0.3619, 210, 100], [32, 33, 0.3410, 0.5302, 60, 40]
];

test('every impedance and every load is the published value', () => {
  const zBase = (12.66 * 12.66) / 10;
  assert.equal(net.branch.length, PUBLISHED.length);

  PUBLISHED.forEach(([from, to, r, x, p, q], i) => {
    const branch = net.branch[i];
    assert.deepEqual([branch.from, branch.to], [from, to], `branch ${i} runs ${branch.from}-${branch.to}`);
    assert.ok(Math.abs(branch.r * zBase - r) < 1e-9, `R ${from}-${to} is ${branch.r * zBase}, published ${r}`);
    assert.ok(Math.abs(branch.x * zBase - x) < 1e-9, `X ${from}-${to} is ${branch.x * zBase}, published ${x}`);

    const bus = net.bus.find(b => b.id === to);
    assert.ok(Math.abs(bus.pd * 1000 - p) < 1e-9, `P at bus ${to}`);
    assert.ok(Math.abs(bus.qd * 1000 - q) < 1e-9, `Q at bus ${to}`);
  });
});

test('the feeder reproduces the published Baran-Wu solution at its own slack voltage', () => {
  const published = JSON.parse(JSON.stringify(net));
  published.gen[0].vg = 1.0;

  const result = solvePowerFlow(published, {});
  assert.equal(result.converged, true);

  // Published: 202.7 kW of loss, 0.9131 pu minimum, at bus 18.
  assert.ok(Math.abs(result.lossesMw * 1000 - 202.7) < 0.2, `losses ${result.lossesMw * 1000}`);

  const vms = result.buses.map(b => b.vm);
  const lowest = Math.min(...vms);
  assert.ok(Math.abs(lowest - 0.9131) < 5e-4, `vmin ${lowest}`);
  assert.equal(result.buses[vms.indexOf(lowest)].id, 18);
});

test('the case carries the published load, unaltered', () => {
  const p = net.bus.reduce((sum, bus) => sum + bus.pd, 0) * 1000;
  const q = net.bus.reduce((sum, bus) => sum + bus.qd, 0) * 1000;
  assert.ok(Math.abs(p - 3715) < 0.5, `P ${p}`);
  assert.ok(Math.abs(q - 2300) < 0.5, `Q ${q}`);
  assert.equal(net.bus.length, 33);
  assert.equal(net.branch.length, 32);
});

test('it ships with the tap position and rating assumptions stated', () => {
  assert.equal(net.gen[0].vg, 1.02);
  assert.match(net.voltageBandNote, /1\.00 pu/);
  assert.match(net.ratingsNote, /assumed/i);
  assert.equal(headIndex(net), 0);
});

/** The load, as a share of the published case, above which bus 18 leaves the band. */
function breachThreshold(slackVg) {
  const tapped = JSON.parse(JSON.stringify(net));
  tapped.gen[0].vg = slackVg;
  let lo = 0;
  let hi = 1.5;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const lowest = Math.min(...solvePowerFlow(tapped, { loadScale: mid }).buses.map(b => b.vm));
    if (lowest < 0.94) hi = mid; else lo = mid;
  }
  return lo;
}

test('the band is breached above about 71 per cent of load untapped, and 95 per cent at 1.02 pu', () => {
  // Both figures are quoted on the page.
  assert.ok(Math.abs(breachThreshold(1.0) - 0.71) < 0.005, `untapped ${breachThreshold(1.0)}`);
  assert.ok(Math.abs(breachThreshold(1.02) - 0.95) < 0.005, `tapped ${breachThreshold(1.02)}`);
});

test('the tap lifts the feeder by 0.020 to 0.022 pu, as the page says', () => {
  const untapped = JSON.parse(JSON.stringify(net));
  untapped.gen[0].vg = 1.0;
  const before = solvePowerFlow(untapped, {}).buses;
  const after = solvePowerFlow(net, {}).buses;
  after.slice(1).forEach((bus, i) => {
    const lift = bus.vm - before[i + 1].vm;
    assert.ok(lift > 0.0199 && lift < 0.0221, `bus ${bus.id} lifted ${lift}`);
  });
});

test('voltage falls monotonically along the trunk', () => {
  const result = solvePowerFlow(net, {});
  const v = new Map(result.buses.map(b => [b.id, b.vm]));
  for (let id = 2; id <= 18; id++) {
    assert.ok(v.get(id) < v.get(id - 1) + 1e-9, `bus ${id} rose above bus ${id - 1}`);
  }
});

/* ---------------- dispatch ---------------- */

test('a battery is a scheduled injection, and does not hold voltage', () => {
  const changed = withBattery(net, { bus: 18, mw: 0.5 });
  const added = changed.gen[changed.gen.length - 1];
  assert.equal(added.bus, 18);
  assert.equal(added.pg, 0.5);
  assert.equal(added.qg, 0);
  assert.equal(net.gen.length, 1, 'the original case must not be mutated');
});

test('the schedule never creates energy: discharge is capped by what was stored', () => {
  const { schedule } = run();
  assert.ok(schedule.dischargedMwh <= schedule.chargedMwh / ROUND_TRIP + 2.25, 'more out than could have gone in');
  assert.ok(schedule.dischargedMwh > 0);
  assert.ok(schedule.chargedMwh > 0);
});

test('no setpoint exceeds the power rating', () => {
  const { schedule } = run({ powerMw: 0.45 });
  schedule.setpoints.forEach(mw => assert.ok(Math.abs(mw) <= 0.45 + 1e-9, `setpoint ${mw}`));
});

test('network-support charges gentler than a merchant rule', () => {
  const merchant = run({ mode: 'price' }).schedule;
  const dno = run({ mode: 'network' }).schedule;
  const deepest = points => Math.min(...points);
  assert.ok(deepest(dno.setpoints) > deepest(merchant.setpoints), 'network mode should draw less at its worst');
});

test('a zero-size battery changes nothing', () => {
  const w = window_();
  const schedule = scheduleBattery({ ...w, powerMw: 0, energyMwh: 0, mode: 'network' });
  assert.ok(schedule.setpoints.every(mw => mw === 0));
  assert.equal(withBattery(net, { bus: 18, mw: 0 }).gen.length, 1);
});

/* ---------------- siting ---------------- */

/** Loss removed by a steady injection, in MW. */
function lossRemoved(bus, mw, loadScale) {
  const without = solvePowerFlow(net, { loadScale }).lossesMw;
  return without - solvePowerFlow(withBattery(net, { bus, mw }), { loadScale }).lossesMw;
}

test('a few hundred kW at the trunk end removes around twenty times the loss it does at the head', () => {
  for (const loadScale of [0.7, 0.85, 1.0]) {
    for (const mw of [0.25, 0.45]) {
      const ratio = lossRemoved(18, mw, loadScale) / lossRemoved(2, mw, loadScale);
      assert.ok(ratio > 15 && ratio < 30, `${mw} MW at ${loadScale}: ${ratio.toFixed(1)}x`);
    }
  }
});

test('location is not distance: the gap narrows with size, and a big injection on a spur adds loss', () => {
  const small = lossRemoved(18, 0.25, 0.7) / lossRemoved(2, 0.25, 0.7);
  const large = lossRemoved(18, 1.0, 0.7) / lossRemoved(2, 1.0, 0.7);
  assert.ok(large < small / 2, `the gap should narrow: ${small.toFixed(1)}x then ${large.toFixed(1)}x`);

  for (const loadScale of [0.7, 0.85, 1.0]) {
    assert.ok(lossRemoved(22, 1.0, loadScale) < 0, `1 MW at bus 22 should add loss at ${loadScale}`);
  }
});

test('charging at half power for twice as long saves far less loss than a quarter', () => {
  // The battery's current adds to load current already on the feeder, and that
  // cross term does not shrink when the charge is spread out.
  for (const loadScale of [0.6, 0.8]) {
    const base = solvePowerFlow(net, { loadScale }).lossesMw;
    const full = solvePowerFlow(withBattery(net, { bus: 18, mw: -0.45 }), { loadScale }).lossesMw - base;
    const half = solvePowerFlow(withBattery(net, { bus: 18, mw: -0.225 }), { loadScale }).lossesMw - base;
    const ratio = (2 * half) / full;
    assert.ok(ratio > 0.75 && ratio < 0.9, `half power for twice as long costs ${ratio.toFixed(3)} of the loss`);
  }
});

test('the same battery does far more at the feeder end than at its head', () => {
  const head = run({ bus: 2 });
  const middle = run({ bus: 6 });
  assert.ok(
    middle.worth.lossMwhSaved > head.worth.lossMwhSaved * 4,
    `head ${head.worth.lossMwhSaved} vs middle ${middle.worth.lossMwhSaved}`
  );
});

test('siting changes the recommendation, not just the numbers', () => {
  assert.equal(run({ bus: 2 }).call.level, 'partial');
  assert.equal(run({ bus: 6 }).call.level, 'yes');
});

test('a short battery cannot use its own power rating across a long peak', () => {
  // Because the window has to close on itself, a two-hour battery can only put
  // back what it took in, so it never reaches its rated output at the peak
  // half-hour. Rated power is an upper bound the energy has to pay for.
  const short = run({ powerMw: 0.45, energyMwh: 0.9 });
  const long = run({ powerMw: 0.45, energyMwh: 2.7 });

  assert.ok(short.assessment.atPeak.setpointMw < 0.45 * 0.9, 'a short battery should be throttled at the peak');
  assert.ok(long.assessment.atPeak.setpointMw > short.assessment.atPeak.setpointMw);
});

test('duration, not power, is what clears the constraint', () => {
  const short = run({ powerMw: 0.45, energyMwh: 0.9 });
  const long = run({ powerMw: 0.45, energyMwh: 2.25 });

  assert.equal(short.call.level, 'partial');
  assert.equal(long.call.level, 'yes');
  assert.ok(long.assessment.withBattery.vmin > short.assessment.withBattery.vmin);
});

test('more energy stops helping once charging reaches into the busy hours', () => {
  // The best result is not the biggest battery: past a point the charge window
  // has to spread into half-hours that are themselves loaded, and the worst
  // half-hour starts going backwards again.
  const best = run({ powerMw: 0.45, energyMwh: 2.7 });
  const bigger = run({ powerMw: 0.45, energyMwh: 3.6 });
  assert.ok(
    bigger.assessment.withBattery.vmin < best.assessment.withBattery.vmin,
    'expected the oversized battery to do slightly worse at its worst half-hour'
  );
});

test('an oversized merchant battery is refused for charging, not discharging', () => {
  const call = run({ bus: 18, powerMw: 1.0, energyMwh: 2.0, mode: 'price' }).call;
  assert.equal(call.level, 'no');
  assert.match(call.binding, /charging|Thermal/i);
});

test('the baseline is independent of the battery and can be reused', () => {
  const w = window_();
  const base = baseline(net, w.demandScale);
  assert.equal(base.length, SLOTS);

  const schedule = scheduleBattery({ ...w, powerMw: 0.45, energyMwh: 2.25, mode: 'network' });
  const fresh = assess(net, { bus: 18, setpoints: schedule.setpoints, demandScale: w.demandScale });
  const cached = assess(net, { bus: 18, setpoints: schedule.setpoints, demandScale: w.demandScale, baseSeries: base });
  assert.equal(fresh.base.lossesMwh, cached.base.lossesMwh);
  assert.equal(fresh.withBattery.vmin, cached.withBattery.vmin);
});

/* ---------------- accounting ---------------- */

test('round-trip losses are paid: charging always exceeds discharging', () => {
  const { schedule } = run();
  assert.ok(schedule.chargedMwh > schedule.dischargedMwh, 'a lossless battery would be a bug');
});

test('carbon is signed so that positive means more emissions', () => {
  const flat = window_();
  flat.carbon = new Array(SLOTS).fill(150);   // nothing to arbitrage against

  const schedule = scheduleBattery({ ...flat, powerMw: 0.45, energyMwh: 2.25, mode: 'carbon' });
  const assessment = assess(net, { bus: 18, setpoints: schedule.setpoints, demandScale: flat.demandScale });
  const worth = value({ assessment, setpoints: schedule.setpoints, price: flat.price, carbon: flat.carbon, energyMwh: 2.25 });

  // With a flat intensity there is no gap to exploit, so shifting energy can
  // only lose: the round trip is burnt for nothing.
  assert.ok(worth.operationalKg > 0, `expected added emissions, got ${worth.operationalKg}`);
});

test('the two ledgers stay separate', () => {
  const { worth } = run();
  assert.ok('lossValue' in worth && 'arbitrage' in worth);
  assert.ok(!('total' in worth), 'network and owner value must never be summed');
});

test('embodied carbon is reported as a band, over the stated life', () => {
  const { worth } = run({ energyMwh: 2 });
  assert.ok(worth.embodiedKgPerDay.high > worth.embodiedKgPerDay.low);
  // 2 MWh x 50 kg/kWh over 15 years.
  assert.ok(Math.abs(worth.embodiedKgPerDay.low - (2000 * 50) / (15 * 365)) < 1e-6);
});

test('the diesel comparison covers the energy actually delivered', () => {
  const { worth, schedule } = run();
  assert.ok(Math.abs(worth.dischargedMwh - schedule.dischargedMwh) < 1e-9);
  assert.ok(Math.abs(worth.dieselKg - worth.dischargedMwh * 1000 * DIESEL_KG_PER_KWH) < 1e-6);
});

test('diesel is counted in kg per kWh generated, from the same factors as Project 01', () => {
  const site = JSON.parse(readFileSync(new URL('../data/site-warehouse.json', import.meta.url), 'utf8'));
  const find = (object, key) => {
    if (object && typeof object === 'object') {
      if (key in object) return object[key];
      for (const value of Object.values(object)) {
        const hit = find(value, key);
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  };
  const litresPerKwh = find(site, 'generatorLitresPerKwh');
  const kgPerLitre = find(site, 'dieselKgPerLitre');

  assert.ok(Math.abs(DIESEL_KG_PER_KWH - litresPerKwh * kgPerLitre) < 1e-12);
  // 0.27 is the litres figure; as carbon it would understate diesel by 2.6 times.
  assert.ok(DIESEL_KG_PER_KWH > 0.6 && DIESEL_KG_PER_KWH < 0.8);
});

/* ---------------- presentation ---------------- */

test('a verdict always names its binding constraint', () => {
  for (const bus of [2, 6, 10, 18, 25, 33]) {
    for (const mode of ['price', 'carbon', 'network']) {
      const call = run({ bus, mode });
      assert.ok(call.call.binding, `no binding constraint at bus ${bus}, ${mode}`);
      assert.ok(call.call.reason.length > 40);
      assert.ok(['yes', 'no', 'partial', 'marginal'].includes(call.call.level));
    }
  }
});

test('a verdict never says losses fall by a negative amount', () => {
  for (const bus of [2, 6, 12, 18, 22, 25, 33]) {
    for (const mode of ['price', 'carbon', 'network']) {
      for (const powerMw of [0.15, 0.45, 1.0]) {
        const { reason } = run({ bus, mode, powerMw, energyMwh: powerMw * 5 }).call;
        assert.doesNotMatch(reason, /-\d|−\d/, `signed number in: ${reason}`);
      }
    }
  }
});

test('money never prints as minus zero', () => {
  assert.equal(fmtGbp(-0.2), '£0');
  assert.equal(fmtGbp(0), '£0');
  assert.equal(fmtGbp(-140), '−£140');
  assert.equal(fmtGbp(1500), '£1,500');
});

test('every licence area the carbon API serves is offered', () => {
  assert.equal(REGIONS.length, 14);
  assert.deepEqual(REGIONS.map(r => r.id), Array.from({ length: 14 }, (_, i) => i + 1));
  REGIONS.forEach(region => assert.ok(region.name && region.dno));
});

test('the window is a whole day of half-hours', () => {
  assert.equal(SLOTS * HOURS_PER_SLOT, 24);
});

test('the window ends with the last finished half-hour, not the one still running', () => {
  const now = Date.parse('2026-09-12T22:57:00Z');
  const starts = slotStarts(now);
  assert.equal(starts.length, SLOTS);
  assert.equal(new Date(starts[SLOTS - 1]).toISOString(), '2026-09-12T22:00:00.000Z');
  assert.equal(new Date(starts[0]).toISOString(), '2026-09-11T22:30:00.000Z');
});

test('prices and demand are asked for by London settlement date, so the 23:00 UTC hour is not lost', () => {
  // In summer the half-hour starting 23:00 UTC is period 1 of the next London day.
  const starts = slotStarts(Date.parse('2026-09-12T23:40:00Z'));
  assert.equal(new Date(starts[SLOTS - 1]).toISOString(), '2026-09-12T23:00:00.000Z');
  assert.deepEqual(settlementDates(starts), ['2026-09-12', '2026-09-13']);

  // In winter London is on UTC, and the same hour stays on its own date.
  const winter = slotStarts(Date.parse('2026-01-12T23:40:00Z'));
  assert.deepEqual(settlementDates(winter), ['2026-01-11', '2026-01-12']);
});

test('the window closes on itself: the cell ends where it started', () => {
  for (const mode of ['price', 'carbon', 'network']) {
    for (const powerMw of [0.15, 0.45, 1.0]) {
      const w = window_();
      const s = scheduleBattery({ ...w, powerMw, energyMwh: powerMw * 5, mode });
      const drift = Math.abs(s.endSoc - (powerMw * 5) / 2);
      assert.ok(drift < 1e-6, `${mode} at ${powerMw} MW drifted ${drift} MWh over the window`);
    }
  }
});
