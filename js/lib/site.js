// js/lib/site.js
//
// The engine behind "Does resilience change the investment?". No DOM and no
// fetch: every function is pure over the case file in data/site-warehouse.json,
// so it runs identically in the page and under node --test.
//
// It compares three pathways for one warehouse, as the demonstrator proposes:
//
//   1  the existing arrangement - gas heat, diesel vans, the grid;
//   2  cost + carbon           - the cheapest plan that meets the carbon target,
//                                judged on energy and carbon figures alone;
//   3  cost + carbon + engineering - the same, but the plan must also fit the
//                                connection, pass an AC power flow on the site
//                                network, and keep essential load running
//                                through an outage.
//
// The planning step is a sweep over a small set of options on representative
// days, not an optimiser; the page says so. A breach the AC check finds is
// returned to the plan as a tighter constraint and the plan is re-run - the
// feedback loop of the full framework, in miniature.

import { solvePowerFlow, violations } from './powerflow.js';

export const ROUND_TRIP = 0.88;
const ETA = Math.sqrt(ROUND_TRIP);

export const OPTIONS = {
  pvKwp: [0, 250, 500, 750],
  battery: [
    null,
    ...[250, 500].flatMap(powerKw => [500, 1000, 1500, 2000].map(energyKwh => ({ powerKw, energyKwh })))
  ],
  generatorKw: [0, 300]
};

export const RIDE_THROUGH_HOURS = [0, 2, 4, 8];

/* ------------------------------------------------------------------ *
 * Loads
 * ------------------------------------------------------------------ */

/** Site electrical load, kW, per half-hour, and the part of it that is essential. */
export function siteLoad(day, electrified) {
  const L = day.load;
  const total = new Float64Array(L.ops.length);
  for (let k = 0; k < total.length; k++) {
    total[k] = L.ops[k] + L.cold[k] + L.it[k] + (electrified ? L.hp[k] + L.ev[k] : 0);
  }
  return total;
}

export function essentialLoad(day) {
  return day.load.cold.map((c, k) => c + day.load.it[k]);
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

/**
 * One day of battery operation, as the operating rule a site owner would run:
 * charge from solar surplus and in the green band, discharge into the red band,
 * and - where there is a connection limit - discharge whatever the site needs
 * above it. The battery never goes below its reserve floor.
 *
 * Each representative day is simulated until it repeats itself: the state of
 * charge at midnight is fed back as the next day's starting point until the
 * two agree, so every day's energy is paid for within that day.
 */
export function dispatchDay(day, plan, { electrified, limitKw = Infinity, floorKwh = 0 }) {
  const n = day.pvPerKwp.length;
  const dt = 0.5;
  const load = siteLoad(day, electrified);
  const pv = day.pvPerKwp.map(p => p * (plan.pvKwp || 0));
  const net = load.map((l, k) => l - pv[k]);
  const P = plan.battery?.powerKw || 0;
  const E = plan.battery?.energyKwh || 0;
  const floor = Math.min(floorKwh, E);

  // What the connection limit obliges the battery to discharge, and what it
  // could charge in each half-hour (solar surplus, or grid headroom in the
  // green band). Neither depends on the state of charge.
  const need = net.map(v => Math.max(0, v - limitKw));
  const chargeCap = net.map((v, k) => (need[k] > 0 ? 0 : Math.min(P,
    Math.max(Math.max(0, -v), day.band[k] === 'green' ? Math.max(0, limitKw - v) : 0))));

  // Look-ahead: the energy the battery must hold at the start of each
  // half-hour to meet every later limit discharge, given the charging it can
  // do in between. Arbitrage may only spend energy above this line - without
  // it, a battery drains itself in the red band and is empty for the evening
  // hours when the site actually exceeds its connection. Two passes round the
  // circular day settle the wrap at midnight.
  const hold = new Float64Array(n);
  let h = floor;
  for (let pass = 0; pass < 2; pass++) {
    for (let k = n - 1; k >= 0; k--) {
      h = Math.min(E, Math.max(floor, h + (need[k] / ETA) * dt - chargeCap[k] * ETA * dt));
      hold[k] = h;
    }
  }

  const run = s0 => {
    let s = s0;
    const soc = new Float64Array(n);
    const charge = new Float64Array(n);
    const discharge = new Float64Array(n);
    const grid = new Float64Array(n);
    const unmet = new Float64Array(n);

    for (let k = 0; k < n; k++) {
      soc[k] = s;
      const next = hold[(k + 1) % n];
      // The limit discharge comes first and may use everything above the reserve floor.
      const dLimit = Math.min(need[k], P, Math.max(0, (s - floor) * ETA / dt));
      // Arbitrage in the red band covers site load only - it never exports - and
      // never dips below what later limit discharges will need.
      const afterLimit = s - (dLimit / ETA) * dt;
      const dTrade = day.band[k] === 'red'
        ? Math.min(P - dLimit, Math.max(0, net[k] - dLimit), Math.max(0, (afterLimit - next) * ETA / dt))
        : 0;
      const d = dLimit + dTrade;
      let c = 0;
      if (d <= 1e-9) {
        const room = Math.max(0, (E - s) / (ETA * dt));
        c = Math.min(room, chargeCap[k]);
      }
      s += c * ETA * dt - (d / ETA) * dt;
      charge[k] = c;
      discharge[k] = d;
      grid[k] = net[k] + c - d;
      unmet[k] = Math.max(0, need[k] - dLimit);
    }
    return { endSoc: s, soc, charge, discharge, grid, unmet };
  };

  let s0 = floor + (E - floor) / 2;
  let result = run(s0);
  for (let i = 0; i < 60 && Math.abs(result.endSoc - s0) > 1e-7 * Math.max(E, 1); i++) {
    s0 = result.endSoc;
    result = run(s0);
  }
  return { ...result, load, pv, net, floorKwh: floor };
}

/* ------------------------------------------------------------------ *
 * Resilience
 * ------------------------------------------------------------------ */

/**
 * Essential load through an outage of `hours`, starting at every half-hour of
 * the scenario day in turn, from the state of charge the dispatch left there.
 *
 * A battery can only carry the site through an outage if it is built to form
 * its own grid; an ordinary grid-following battery trips with the mains, and so
 * does rooftop PV, which needs something to follow. A standby generator forms
 * a grid on its own. The day wraps round at midnight.
 */
export function outageTest(day, plan, trace, hours, { fromSoc = null } = {}) {
  const n = day.pvPerKwp.length;
  const dt = 0.5;
  const steps = Math.round(hours / dt);
  const ess = essentialLoad(day);
  const gridForming = Boolean(plan.battery && plan.islanding);
  const generator = plan.generatorKw || 0;
  const pvUsable = gridForming || generator > 0;
  const P = gridForming ? plan.battery.powerKw : 0;
  const E = gridForming ? plan.battery.energyKwh : 0;

  let worstEnsKwh = 0;
  let worstStart = 0;
  let shortestHeldHours = hours;
  let tightestStart = 0;
  let tightestMargin = Infinity;

  for (let k = 0; k < n; k++) {
    let s = gridForming ? (fromSoc ?? trace.soc[k]) : 0;
    let ens = 0;
    let held = null;
    let lowest = s;
    for (let j = 0; j < steps; j++) {
      const i = (k + j) % n;
      const pv = pvUsable ? day.pvPerKwp[i] * (plan.pvKwp || 0) : 0;
      const need = ess[i] - pv - generator;
      if (need > 0) {
        const d = Math.min(P, need, Math.max(0, s) * ETA / dt);
        s -= (d / ETA) * dt;
        const short = need - d;
        if (short > 1e-9) {
          ens += short * dt;
          if (held === null) held = j * dt;
        }
      } else if (gridForming) {
        s = Math.min(E, s + Math.min(P, -need) * ETA * dt);
      }
      lowest = Math.min(lowest, s);
    }
    if (ens > worstEnsKwh + 1e-9) { worstEnsKwh = ens; worstStart = k; }
    if (ens <= 1e-9 && lowest < tightestMargin) { tightestMargin = lowest; tightestStart = k; }
    if (held !== null) shortestHeldHours = Math.min(shortestHeldHours, held);
  }

  return {
    hours,
    pass: worstEnsKwh <= 1e-6,
    worstEnsKwh,
    worstStart,
    // For a plan that passes from every start, the one that left least in the battery.
    tightestStart,
    heldHours: hours === 0 ? 0 : shortestHeldHours
  };
}

/**
 * The smallest reserve that carries essential load through the outage from any
 * start, found by bisection. Starting every trial at the floor itself is the
 * conservative case: the dispatch never lets the battery sit below it.
 */
export function requiredFloor(day, plan, hours) {
  if (!hours || !plan.battery || !plan.islanding) return 0;
  const E = plan.battery.energyKwh;
  const passesAt = f => outageTest(day, plan, null, hours, { fromSoc: f }).pass;
  if (!passesAt(E)) return Infinity;
  if (passesAt(0)) return 0;
  let lo = 0;
  let hi = E;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (passesAt(mid)) hi = mid; else lo = mid;
  }
  return hi;
}

/* ------------------------------------------------------------------ *
 * The site network
 * ------------------------------------------------------------------ */

const tanPhi = pf => Math.tan(Math.acos(pf));

/** The site network for a connection scenario, with the transformer sized to match. */
export function siteNetwork(caseData, connectionKey) {
  const base = caseData.network;
  const conn = caseData.connections[connectionKey];
  const t = base.transformer;
  const z = t.impedancePu * (base.baseMVA / (conn.transformerKva / 1000));
  const r = z / Math.sqrt(1 + t.xOverR ** 2);
  return {
    baseMVA: base.baseMVA,
    bus: base.bus.map(b => ({ ...b })),
    gen: [{ bus: 1, pg: 0, qg: 0, qmax: 99, qmin: -99, vg: base.sourceVoltagePu, status: 1 }],
    branch: [
      { from: t.from, to: t.to, name: `Transformer ${conn.transformerKva} kVA`, r, x: r * t.xOverR, b: 0, ratio: 1, shift: 0, status: 1, rateA: conn.transformerKva / 1000 },
      ...base.cables.map(c => ({ ...c }))
    ]
  };
}

/** Load one half-hour's operating point onto the network and solve it. */
export function acSnapshot(caseData, connectionKey, day, k, plan, trace, electrified) {
  const net = siteNetwork(caseData, connectionKey);
  const pf = caseData.recipe.pf;
  const L = day.load;
  const boardKw = {
    ops: L.ops[k],
    cold: L.cold[k],
    it: L.it[k],
    hp: electrified ? L.hp[k] : 0,
    ev: electrified ? L.ev[k] : 0
  };
  for (const bus of net.bus) {
    if (bus.board && boardKw[bus.board] !== undefined) {
      bus.pd = boardKw[bus.board] / 1000;
      bus.qd = bus.pd * tanPhi(pf[bus.board]);
    }
  }
  const pvKw = trace.pv[k];
  const batteryKw = trace.discharge[k] - trace.charge[k];
  if (pvKw) net.gen.push({ bus: 8, pg: pvKw / 1000, qg: 0, qmax: 0, qmin: 0, vg: 1, status: 1 });
  if (batteryKw) net.gen.push({ bus: 9, pg: batteryKw / 1000, qg: 0, qmax: 0, qmin: 0, vg: 1, status: 1 });

  const result = solvePowerFlow(net, {});
  if (!result.converged) return { converged: false, pass: false, binding: 'Power flow did not converge' };

  const conn = caseData.connections[connectionKey];
  const head = result.branches[0];
  const importKva = Math.hypot(head.pFrom, head.qFrom) * 1000;
  const found = violations(result);
  const transformerLoading = head.loading;
  const cables = result.branches.slice(1);
  const worstCable = cables.reduce((a, b) => (b.loading > a.loading ? b : a));
  const vms = result.buses.slice(1).map(b => b.vm);

  const breaches = [];
  if (importKva > conn.ascKva + 1e-6) breaches.push(`import ${Math.round(importKva)} kVA against ${conn.ascKva} kVA agreed capacity`);
  if (transformerLoading > 1 + 1e-9) breaches.push(`transformer at ${Math.round(transformerLoading * 100)}% of rating`);
  if (found.overload.some(o => o.index > 0)) breaches.push(`a site cable at ${Math.round(worstCable.loading * 100)}% of rating`);
  if (found.voltage.length) breaches.push(`a board at ${Math.min(...vms).toFixed(3)} pu, outside 0.94-1.10`);

  return {
    converged: true,
    pass: breaches.length === 0,
    binding: breaches[0] ?? null,
    breaches,
    importKva,
    transformerLoading,
    worstCableLoading: worstCable.loading,
    vmin: Math.min(...vms),
    vmax: Math.max(...vms),
    result,
    slot: k,
    date: day.date
  };
}

/* ------------------------------------------------------------------ *
 * A plan, costed and counted
 * ------------------------------------------------------------------ */

function annuity(rate, years) {
  return (1 - (1 + rate) ** -years) / rate;
}

/** Everything about one plan under one set of rules. */
export function evaluatePlan(caseData, plan, rules) {
  const { electrified, limitKw = Infinity, floorKwh = 0 } = rules;
  const F = caseData.factors;
  const Pr = caseData.prices;
  const C = caseData.costs;
  const dt = caseData.hoursPerSlot;

  let importKwh = 0;
  let exportKwh = 0;
  let energyCost = 0;
  let unmetKwh = 0;
  let shiftKg = 0;              // the battery's own effect, in the half-hourly view
  let peakImportKw = 0;
  let peak = null;
  const traces = [];

  for (const day of caseData.days) {
    const tr = dispatchDay(day, plan, { electrified, limitKw, floorKwh });
    traces.push(tr);
    for (let k = 0; k < tr.grid.length; k++) {
      const g = tr.grid[k];
      if (g > 0) {
        importKwh += g * dt * day.weight;
        energyCost += g * dt * day.weight * (Pr.bandGbpPerKwh[day.band[k]] + Pr.cclGbpPerKwh);
      } else {
        exportKwh += -g * dt * day.weight;
        energyCost -= -g * dt * day.weight * Pr.exportGbpPerKwh;
      }
      unmetKwh += tr.unmet[k] * dt * day.weight;
      shiftKg += (tr.charge[k] - tr.discharge[k]) * dt * day.weight * day.carbon[k] / 1000;
      if (g > peakImportKw) { peakImportKw = g; peak = { day, k, trace: tr }; }
    }
  }

  // Heat and fleet energy outside the electricity meter: only the existing site has them.
  const days = caseData.days;
  const gasKwh = electrified ? 0 : days.reduce((s, d) => s + d.load.gas.reduce((a, g) => a + g, 0) * dt * d.weight, 0);
  const vanKm = electrified ? 0 : caseData.recipe.vans * caseData.recipe.kmPerVanDay * 365;
  const vanLitres = vanKm * F.vanKgPerKm / F.dieselKgPerLitre;

  const genKw = plan.generatorKw || 0;
  const genTestLitres = genKw * 0.5 * C.generatorTestHoursYr * C.generatorLitresPerKwh;

  energyCost += gasKwh * (Pr.gasGbpPerKwh + Pr.cclGbpPerKwh);
  energyCost += (vanLitres + genTestLitres) * Pr.dieselGbpPerLitre;

  // Capital, operation, replacement, residual value.
  const pvCapex = (plan.pvKwp || 0) * C.pvGbpPerKwp;
  const batteryCapex = plan.battery ? plan.battery.energyKwh * C.batteryGbpPerKwh + plan.battery.powerKw * C.batteryGbpPerKw : 0;
  const islandCapex = plan.battery && plan.islanding ? C.islandingGbp : 0;
  const genCapex = genKw * C.generatorGbpPerKw;
  const capex = pvCapex + batteryCapex + islandCapex + genCapex;
  const om = (plan.pvKwp || 0) * C.pvOmGbpPerKwpYr + batteryCapex * C.batteryOmFrac + genCapex * C.generatorOmFrac;

  const { discountRate: r, years } = caseData.finance;
  const replaceAt = C.batteryLifeYears;
  const replacement = replaceAt < years ? (batteryCapex + islandCapex) * (1 + r) ** -replaceAt : 0;
  const residual = (
    pvCapex * Math.max(0, C.pvLifeYears - years) / C.pvLifeYears
    + (batteryCapex + islandCapex) * (replaceAt < years ? (2 * replaceAt - years) / replaceAt : Math.max(0, replaceAt - years) / replaceAt)
    + genCapex * Math.max(0, C.generatorLifeYears - years) / C.generatorLifeYears
  ) * (1 + r) ** -years;
  const presentCost = capex + (energyCost + om) * annuity(r, years) + replacement - residual;

  // Emissions, first operating year, DESNZ 2026 factors.
  const scope1 = (gasKwh * F.gasKg + vanKm * F.vanKgPerKm + genTestLitres * F.dieselKgPerLitre) / 1000;
  const scope2 = importKwh * F.electricityKg / 1000;
  const scope3 = (importKwh * (F.tdKg + F.wttGenerationKg + F.wttTdKg)
    + gasKwh * F.wttGasKg + (vanLitres + genTestLitres) * F.wttDieselKgPerLitre) / 1000;
  const embodied = ((plan.pvKwp || 0) * caseData.embodied.pvKgPerKwp
    + (plan.battery?.energyKwh || 0) * caseData.embodied.batteryKgPerKwh) / 1000;

  return {
    plan,
    importKwh,
    exportKwh,
    unmetKwh,
    peakImportKw,
    peak,
    traces,
    energyCostYr: energyCost,
    omYr: om,
    capex,
    presentCost,
    scope1,
    scope2,
    scope3,
    residual: scope1 + scope2 + scope3,
    embodied,
    batteryShiftKg: shiftKg,
    floorKwh
  };
}

/* ------------------------------------------------------------------ *
 * The three pathways
 * ------------------------------------------------------------------ */

function candidates({ allowResilience }) {
  const out = [];
  for (const pvKwp of OPTIONS.pvKwp) {
    for (const battery of OPTIONS.battery) {
      for (const generatorKw of allowResilience ? OPTIONS.generatorKw : [0]) {
        for (const islanding of allowResilience && battery ? [false, true] : [false]) {
          out.push({ pvKwp, battery, generatorKw, islanding });
        }
      }
    }
  }
  return out;
}

export const samePlan = (a, b) => Boolean(a && b)
  && a.pvKwp === b.pvKwp
  && a.generatorKw === b.generatorKw
  && Boolean(a.islanding) === Boolean(b.islanding)
  && (a.battery?.powerKw || 0) === (b.battery?.powerKw || 0)
  && (a.battery?.energyKwh || 0) === (b.battery?.energyKwh || 0);

/** Worst import across the representative days and the scenario day. */
function worstSnapshot(evalResult, scenarioDay, scenarioTrace) {
  let best = evalResult.peak;
  if (scenarioTrace) {
    for (let k = 0; k < scenarioTrace.grid.length; k++) {
      if (!best || scenarioTrace.grid[k] > best.trace.grid[best.k]) best = { day: scenarioDay, k, trace: scenarioTrace };
    }
  }
  return best;
}

export function solvePathways(caseData, { hours = 4, hazard = 'correlated', connection = 'today', diesel = false } = {}) {
  const conn = caseData.connections[connection];
  const scenario = caseData.scenarios[hazard];
  const limitKw = conn.ascKva * caseData.pfPlan;

  // 1 - existing arrangement.
  const existingPlan = { pvKwp: 0, battery: null, generatorKw: 0, islanding: false };
  const existing = evaluatePlan(caseData, existingPlan, { electrified: false });
  const baseline12 = existing.scope1 + existing.scope2;
  const meetsTarget = e => e.scope1 + e.scope2 <= baseline12 * (1 - caseData.target.scope12CutFrac) + 1e-9;

  const describe = (e, electrified, floorKwh) => {
    const scenarioTrace = dispatchDay(scenario, e.plan, { electrified, limitKw: e.limitKw ?? Infinity, floorKwh });
    const snap = worstSnapshot(e, scenario, scenarioTrace);
    const ac = acSnapshot(caseData, connection, snap.day, snap.k, e.plan, snap.trace, electrified);
    const resilience = outageTest(scenario, e.plan, scenarioTrace, hours);
    return { ...e, ac, resilience, scenarioTrace, vollPerEvent: resilience.worstEnsKwh * caseData.vollGbpPerKwh };
  };

  const pathway1 = describe(existing, false, 0);

  // 2 - cost + carbon, judged on annual energy and carbon alone.
  const pool2 = candidates({ allowResilience: false })
    .map(plan => evaluatePlan(caseData, plan, { electrified: true }))
    .filter(meetsTarget)
    .sort((a, b) => a.presentCost - b.presentCost);
  const pathway2 = pool2.length ? describe(pool2[0], true, 0) : null;

  // 3 - the same objective, with the engineering requirements as constraints.
  const screened = [];
  for (const plan of candidates({ allowResilience: true })) {
    // A new diesel generator is a policy choice as much as an engineering one:
    // it is often the cheapest resilience, and it adds Scope 1 emissions.
    if (!diesel && plan.generatorKw) continue;
    if (hours > 0 && !plan.islanding && !plan.generatorKw) continue;          // nothing could island
    const floorKwh = requiredFloor(scenario, plan, hours);
    if (!Number.isFinite(floorKwh)) continue;
    const e = evaluatePlan(caseData, plan, { electrified: true, limitKw, floorKwh });
    if (e.unmetKwh > 1e-6 || !meetsTarget(e)) continue;
    e.limitKw = limitKw;
    screened.push(e);
  }
  screened.sort((a, b) => a.presentCost - b.presentCost);

  // Figure 1's loop. A plan that passes the linear screen goes to the AC power
  // flow; a breach of the agreed capacity is returned to that plan as a tighter
  // import cap and the plan is re-run, rather than the plan being thrown away.
  // It matters here because a battery at unity power factor shaves kilowatts
  // but not kilovars: at the planned kW cap, the reactive power of the cold
  // store and the heat pumps can still take the import over its kVA limit.
  // Tightening can only add cost, so once the cheapest untightened plan left
  // costs more than the best accepted one, nothing further can win.
  let pathway3 = null;
  let acTightened = 0;
  let rejectedByAc = 0;
  let rejectedByResilience = 0;
  for (const first of screened) {
    if (pathway3 && first.presentCost >= pathway3.presentCost) break;
    let e = first;
    let d = describe(e, true, e.floorKwh);
    const acHistory = [{ capKw: limitKw, importKva: d.ac.importKva }];
    while (d.resilience.pass && !d.ac.pass && d.ac.importKva > conn.ascKva + 1e-6 && acHistory.length <= 6) {
      const capKw = acHistory[acHistory.length - 1].capKw * (conn.ascKva / d.ac.importKva) - 1;
      const next = evaluatePlan(caseData, e.plan, { electrified: true, limitKw: capKw, floorKwh: e.floorKwh });
      if (next.unmetKwh > 1e-6 || !meetsTarget(next)) break;
      next.limitKw = capKw;
      e = next;
      d = describe(e, true, e.floorKwh);
      acHistory.push({ capKw, importKva: d.ac.importKva });
    }
    if (!d.resilience.pass) { rejectedByResilience++; continue; }
    if (!d.ac.pass) { rejectedByAc++; continue; }
    if (acHistory.length > 1) acTightened++;
    d.acHistory = acHistory;
    if (!pathway3 || d.presentCost < pathway3.presentCost) pathway3 = d;
  }

  return {
    controls: { hours, hazard, connection, diesel },
    scenario,
    connection: conn,
    baseline12,
    pathway1,
    pathway2,
    pathway3,
    acTightened,
    rejectedByAc,
    rejectedByResilience,
    headline: headline(pathway2, pathway3, { hours, hazard, connection: conn, diesel })
  };
}

/* ------------------------------------------------------------------ *
 * The headline, computed rather than written
 * ------------------------------------------------------------------ */

const kw = v => `${Math.round(v).toLocaleString('en-GB')} kW`;
const kwh = v => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)} MWh` : `${Math.round(v)} kWh`);
const describeBattery = b => (b ? `${kw(b.powerKw)} / ${kwh(b.energyKwh)}` : 'no battery');

export function headline(p2, p3, { hours, diesel = false }) {
  if (!p2) {
    return { kind: 'none', text: 'No plan in this option set meets the carbon target on energy and carbon figures alone.' };
  }
  if (!p3) {
    return {
      kind: 'infeasible',
      text: `No plan in this option set meets the engineering requirements${hours ? ` for ${hours === 8 ? 'an' : 'a'} ${hours}-hour ride-through` : ''} on this connection. `
        + `The next step would be a larger connection${diesel ? '' : ', a standby generator'} or a wider set of options — which is the point: `
        + 'the cost-and-carbon plan could not have been built as recommended.'
    };
  }

  const changes = [];
  if (p3.plan.pvKwp !== p2.plan.pvKwp) changes.push(`solar from ${p2.plan.pvKwp} to ${p3.plan.pvKwp} kWp`);
  if ((p3.plan.battery?.energyKwh || 0) !== (p2.plan.battery?.energyKwh || 0)
    || (p3.plan.battery?.powerKw || 0) !== (p2.plan.battery?.powerKw || 0)) {
    changes.push(`the battery from ${describeBattery(p2.plan.battery)} to ${describeBattery(p3.plan.battery)}`);
  }
  if (p3.floorKwh > 1e-6) {
    changes.push(`held ${Math.round(100 * p3.floorKwh / p3.plan.battery.energyKwh)}% of the battery in reserve`);
  }
  if (p3.plan.islanding && !p2.plan.islanding) changes.push('made it able to run the site as an island');
  if (p3.plan.generatorKw && !p2.plan.generatorKw) changes.push(`added a ${kw(p3.plan.generatorKw)} standby generator`);
  // The operating strategy is part of the recommendation too: the same
  // equipment, run to stay inside the connection, is a different plan.
  if (p3.peakImportKw < p2.peakImportKw - 1) {
    changes.push(`capped the site's import at ${kw(p3.peakImportKw)}, where the cost-and-carbon plan peaked at ${kw(p2.peakImportKw)}`);
  }

  const delta = p3.presentCost - p2.presentCost;
  const pct = (100 * delta) / p2.presentCost;

  if (!changes.length && Math.abs(delta) >= 1) changes.push('changed how the same equipment is run');

  if (!changes.length) {
    return {
      kind: 'negative',
      text: 'The engineering requirements made no difference here: the cost-and-carbon plan already fits the connection '
        + 'and passes the resilience test as it stands. Simpler screening would have been enough — which is worth knowing too.'
    };
  }

  const list = changes.length > 1 ? `${changes.slice(0, -1).join(', ')} and ${changes[changes.length - 1]}` : changes[0];
  return {
    kind: 'changed',
    text: `The engineering requirements changed the plan: ${list}, `
      + `at ${delta >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}% on the 20-year cost.`,
    deltaGbp: delta,
    deltaPct: pct
  };
}
