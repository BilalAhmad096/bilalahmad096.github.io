// tests/site.test.js
//
// The case file and the engine behind "Does resilience change the investment?".
// The case is checked first - if its data were wrong nothing downstream would
// mean anything - then the physics of dispatch and outage, then the logic that
// makes the three pathways a fair comparison.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  dispatchDay,
  essentialLoad,
  evaluatePlan,
  outageTest,
  requiredFloor,
  samePlan,
  siteNetwork,
  solvePathways
} from '../js/lib/site.js';

const c = JSON.parse(readFileSync(new URL('../data/site-warehouse.json', import.meta.url), 'utf8'));
const DT = 0.5;
const LIMIT_TODAY = c.connections.today.ascKva * c.pfPlan;

const solve = (controls) => solvePathways(c, controls);
const s12 = p => p.scope1 + p.scope2;

/* ---------------- the case ---------------- */

test('the case covers a year of complete, weekday representative days', () => {
  assert.equal(c.days.length, 12);
  assert.equal(c.days.reduce((s, d) => s + d.weight, 0), 365);
  for (const d of [...c.days, c.scenarios.independent, c.scenarios.correlated]) {
    const dow = new Date(`${d.date}T12:00:00Z`).getUTCDay();
    assert.ok(dow >= 1 && dow <= 5, `${d.date} is not a weekday`);
    for (const key of ['pvPerKwp', 'temp', 'carbon', 'band']) assert.equal(d[key].length, 48, `${d.date} ${key}`);
    assert.ok(d.carbon.every(v => Number.isFinite(v) && v > 0), `${d.date} carbon incomplete`);
    for (const key of ['ops', 'cold', 'it', 'hp', 'ev', 'gas']) assert.equal(d.load[key].length, 48);
  }
});

test('the correlated scenario is the hottest weekday in the case', () => {
  const hot = c.scenarios.correlated;
  assert.equal(hot.date, '2023-09-07');
  for (const d of c.days) assert.ok(hot.tMax >= d.tMax, `${d.date} is hotter`);
});

test('the tariff is calibrated to the DESNZ medium-band average', () => {
  let kwh = 0;
  let cost = 0;
  for (const d of c.days) {
    for (let k = 0; k < 48; k++) {
      const e = (d.load.ops[k] + d.load.cold[k] + d.load.it[k]) * DT * d.weight;
      kwh += e;
      cost += e * c.prices.bandGbpPerKwh[d.band[k]];
    }
  }
  assert.ok(Math.abs(cost / kwh - 0.25358) < 1e-4, `average ${cost / kwh}`);
  assert.ok(c.prices.bandGbpPerKwh.red > c.prices.bandGbpPerKwh.amber);
  assert.ok(c.prices.bandGbpPerKwh.amber > c.prices.bandGbpPerKwh.green);
});

test('emission factors are the published DESNZ 2026 values', () => {
  assert.equal(c.factors.electricityKg, 0.13096);
  assert.equal(c.factors.tdKg, 0.01299);
  assert.equal(c.factors.gasKg, 0.18231);
  assert.equal(c.factors.dieselKgPerLitre, 2.58354);
  assert.equal(c.factors.vanKgPerKm, 0.25716);
});

test('every constant says whether it is sourced or assumed', () => {
  assert.ok(c.sources.length >= 10);
  for (const s of c.sources) {
    assert.ok(['sourced', 'assumed'].includes(s.kind), s.id);
    if (s.kind === 'sourced') assert.match(s.url, /^https:\/\//, s.id);
  }
});

test('the transformer is sized to the connection scenario', () => {
  assert.equal(siteNetwork(c, 'today').branch[0].rateA, 1.0);
  assert.equal(siteNetwork(c, 'reinforced').branch[0].rateA, 1.25);
});

/* ---------------- dispatch ---------------- */

const PLAN = { pvKwp: 750, battery: { powerKw: 500, energyKwh: 1500 }, generatorKw: 0, islanding: false };

test('dispatch balances energy, respects the battery and closes each day on itself', () => {
  for (const day of c.days) {
    const t = dispatchDay(day, PLAN, { electrified: true, limitKw: LIMIT_TODAY, floorKwh: 300 });
    for (let k = 0; k < 48; k++) {
      assert.ok(Math.abs(t.grid[k] - (t.net[k] + t.charge[k] - t.discharge[k])) < 1e-9);
      assert.ok(t.soc[k] >= 300 - 1e-6 && t.soc[k] <= 1500 + 1e-6, `${day.date} soc ${t.soc[k]}`);
      assert.ok(!(t.charge[k] > 1e-9 && t.discharge[k] > 1e-9), 'charging and discharging at once');
      assert.ok(t.charge[k] <= 500 + 1e-9 && t.discharge[k] <= 500 + 1e-9);
    }
    assert.ok(Math.abs(t.endSoc - t.soc[0]) < 1e-3, `${day.date} does not close`);
  }
});

test('the look-ahead keeps energy back for the connection limit', () => {
  // Without it, arbitrage in the red band emptied the battery before the
  // evening hours when the electrified site exceeds its connection.
  for (const day of c.days) {
    const t = dispatchDay(day, PLAN, { electrified: true, limitKw: LIMIT_TODAY });
    assert.ok(t.unmet.every(u => u < 1e-9), `${day.date} exceeds the limit`);
    assert.ok(Math.max(...t.grid) <= LIMIT_TODAY + 1e-6);
  }
});

test('without a limit the battery trades freely and the site can exceed its connection', () => {
  const e = evaluatePlan(c, PLAN, { electrified: true });
  assert.ok(e.peakImportKw > LIMIT_TODAY, `peak ${e.peakImportKw}`);
});

/* ---------------- outage ---------------- */

test('a battery that cannot island carries nothing through an outage', () => {
  const day = c.scenarios.correlated;
  const t = dispatchDay(day, PLAN, { electrified: true });
  const res = outageTest(day, PLAN, t, 2);
  assert.equal(res.pass, false);
  const ess = essentialLoad(day);
  const worst = Math.max(...ess.map((_, k) => [0, 1, 2, 3].reduce((s, j) => s + ess[(k + j) % 48] * DT, 0)));
  assert.ok(Math.abs(res.worstEnsKwh - worst) < 1e-6);
});

test('a generator larger than essential load carries any duration', () => {
  const plan = { ...PLAN, generatorKw: 300 };
  const day = c.scenarios.correlated;
  assert.ok(Math.max(...essentialLoad(day)) < 300);
  assert.equal(outageTest(day, plan, dispatchDay(day, plan, { electrified: true }), 8).pass, true);
});

test('the required reserve is enough, and not more than enough', () => {
  const plan = { pvKwp: 750, battery: { powerKw: 500, energyKwh: 2000 }, generatorKw: 0, islanding: true };
  for (const hazard of ['independent', 'correlated']) {
    const day = c.scenarios[hazard];
    const f = requiredFloor(day, plan, 4);
    assert.ok(Number.isFinite(f) && f > 0);
    assert.equal(outageTest(day, plan, null, 4, { fromSoc: f }).pass, true);
    assert.equal(outageTest(day, plan, null, 4, { fromSoc: f * 0.98 }).pass, false);
  }
});

/* ---------------- the three pathways ---------------- */

const GRID = [];
for (const connection of ['today', 'reinforced']) {
  for (const hazard of ['independent', 'correlated']) {
    for (const hours of [0, 2, 4, 8]) {
      for (const diesel of [false, true]) GRID.push({ connection, hazard, hours, diesel });
    }
  }
}
const RESULTS = GRID.map(controls => ({ controls, r: solve(controls) }));

test('pathway 3 never costs less than pathway 2 - the constraints can only add cost', () => {
  for (const { controls, r } of RESULTS) {
    if (!r.pathway2 || !r.pathway3) continue;
    assert.ok(r.pathway3.presentCost >= r.pathway2.presentCost - 1, JSON.stringify(controls));
  }
});

test('every pathway 3 plan meets every requirement it was set', () => {
  for (const { controls, r } of RESULTS) {
    const p = r.pathway3;
    if (!p) continue;
    assert.equal(p.ac.pass, true, JSON.stringify(controls));
    assert.ok(p.ac.importKva <= r.connection.ascKva + 1e-6);
    assert.equal(p.resilience.pass, true);
    assert.ok(p.unmetKwh < 1e-6);
    if (!controls.diesel) assert.equal(p.plan.generatorKw, 0);
  }
});

test('pathways 2 and 3 both meet the carbon target', () => {
  for (const { r } of RESULTS) {
    for (const p of [r.pathway2, r.pathway3]) {
      if (p) assert.ok(s12(p) <= r.baseline12 * (1 - c.target.scope12CutFrac) + 1e-6);
    }
  }
});

test('a longer ride-through never makes the plan cheaper', () => {
  for (const connection of ['today', 'reinforced']) {
    for (const hazard of ['independent', 'correlated']) {
      let last = -Infinity;
      for (const hours of [0, 2, 4, 8]) {
        const p = solve({ connection, hazard, hours, diesel: false }).pathway3;
        if (!p) { last = Infinity; continue; }
        assert.ok(p.presentCost >= last - 1, `${connection} ${hazard} ${hours}h`);
        last = p.presentCost;
      }
    }
  }
});

test('a correlated outage needs at least the reserve an independent one does', () => {
  for (const hours of [2, 4, 8]) {
    const ind = solve({ connection: 'reinforced', hazard: 'independent', hours, diesel: false }).pathway3;
    const cor = solve({ connection: 'reinforced', hazard: 'correlated', hours, diesel: false }).pathway3;
    assert.ok(cor.floorKwh >= ind.floorKwh - 1e-6, `${hours}h`);
    assert.ok(cor.presentCost >= ind.presentCost - 1, `${hours}h`);
  }
});

test('allowing a diesel generator never makes the answer dearer', () => {
  for (const { controls, r } of RESULTS) {
    if (controls.diesel || !r.pathway3) continue;
    const withDiesel = solve({ ...controls, diesel: true }).pathway3;
    assert.ok(withDiesel.presentCost <= r.pathway3.presentCost + 1, JSON.stringify(controls));
  }
});

test('the cost-and-carbon plan breaches today\'s connection; the existing site does not', () => {
  const r = solve({ connection: 'today', hazard: 'correlated', hours: 4, diesel: false });
  assert.equal(r.pathway1.ac.pass, true);
  assert.equal(r.pathway2.ac.pass, false);
  assert.ok(r.pathway2.ac.importKva > c.connections.today.ascKva);
});

test('the AC check returns a breach to the plan as a tighter cap', () => {
  const p = solve({ connection: 'today', hazard: 'correlated', hours: 2, diesel: false }).pathway3;
  assert.ok(p.acHistory.length > 1, 'expected the cap to be tightened');
  for (let i = 1; i < p.acHistory.length; i++) assert.ok(p.acHistory[i].capKw < p.acHistory[i - 1].capKw);
  assert.ok(p.acHistory[0].importKva > c.connections.today.ascKva, 'the first plan should have breached');
  assert.ok(p.ac.importKva <= c.connections.today.ascKva);
});

test('the negative result appears when nothing binds', () => {
  const r = solve({ connection: 'reinforced', hazard: 'correlated', hours: 0, diesel: false });
  assert.equal(r.headline.kind, 'negative');
  assert.ok(samePlan(r.pathway2.plan, r.pathway3.plan));
});

test('the default settings produce a changed plan', () => {
  const r = solve({ connection: 'today', hazard: 'correlated', hours: 4, diesel: false });
  assert.equal(r.headline.kind, 'changed');
  assert.ok(r.pathway3.plan.islanding);
  assert.ok(r.pathway3.floorKwh > 0);
});

test('a headline is never empty and never prints a placeholder', () => {
  for (const { r } of RESULTS) {
    assert.ok(['changed', 'negative', 'infeasible', 'none'].includes(r.headline.kind));
    assert.ok(r.headline.text.length > 40);
    assert.doesNotMatch(r.headline.text, /undefined|NaN|null/);
  }
});
