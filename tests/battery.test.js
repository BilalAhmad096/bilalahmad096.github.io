// tests/battery.test.js
//
// The feeder case and the siting engine. The case is checked against the
// published Baran-Wu solution first: if the impedances are wrong nothing
// downstream means anything.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { solvePowerFlow } from '../js/lib/powerflow.js';
import {
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
  assert.ok(Math.abs(worth.dieselKg - worth.dischargedMwh * 1000 * 0.27) < 1e-6);
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
