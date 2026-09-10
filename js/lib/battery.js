// js/lib/battery.js
//
// The physics and the accounting behind the storage-siting demonstration. No
// DOM and no fetch in here: everything is a pure function of a network, a
// battery, and a 24-hour window of live GB data, so it can be tested in Node
// and moved to a Worker without change.
//
// The network solve is js/lib/powerflow.js, unchanged from Project 01.

import { solvePowerFlow, violations } from './powerflow.js';

/** Half-hours in the window the page works over. */
export const SLOTS = 48;
export const HOURS_PER_SLOT = 0.5;

/**
 * Round-trip efficiency of a grid-scale lithium system, split evenly between
 * the two directions. 88 per cent is a mid-range AC-side figure including the
 * inverter; it matters here because it is the hurdle the battery has to clear
 * before it reduces carbon at all.
 */
export const ROUND_TRIP = 0.88;
const ONE_WAY = Math.sqrt(ROUND_TRIP);

/** Diesel gen-set, kg CO2e per kWh generated, for the backup comparison. */
export const DIESEL_KG_PER_KWH = 0.27;

/**
 * Embodied carbon of lithium storage, kg CO2e per kWh of installed capacity.
 * Published estimates spread widely with chemistry, factory grid and system
 * boundary, so this is carried as a band and reported as a band.
 */
export const EMBODIED_KG_PER_KWH = { low: 50, high: 150 };
export const ASSET_LIFE_YEARS = 15;

/** The fourteen GB distribution licence areas, as the carbon API numbers them. */
export const REGIONS = [
  { id: 1, name: 'North Scotland', dno: 'Scottish Hydro Electric Power Distribution' },
  { id: 2, name: 'South Scotland', dno: 'SP Distribution' },
  { id: 3, name: 'North West England', dno: 'Electricity North West' },
  { id: 4, name: 'North East England', dno: 'NPG North East' },
  { id: 5, name: 'Yorkshire', dno: 'NPG Yorkshire' },
  { id: 6, name: 'North Wales & Merseyside', dno: 'SP Manweb' },
  { id: 7, name: 'South Wales', dno: 'National Grid South Wales' },
  { id: 8, name: 'West Midlands', dno: 'National Grid West Midlands' },
  { id: 9, name: 'East Midlands', dno: 'National Grid East Midlands' },
  { id: 10, name: 'East England', dno: 'UK Power Networks East' },
  { id: 11, name: 'South West England', dno: 'National Grid South West' },
  { id: 12, name: 'South England', dno: 'SSEN Southern' },
  { id: 13, name: 'London', dno: 'UK Power Networks London' },
  { id: 14, name: 'South East England', dno: 'UK Power Networks South East' }
];

export const MODES = {
  price: {
    label: 'Price-following',
    blurb: 'Charge in the cheapest half-hours of the window, discharge in the dearest. What a merchant battery does.'
  },
  carbon: {
    label: 'Carbon-following',
    blurb: 'Charge when regional intensity is lowest, discharge when it is highest. What a battery run for emissions does.'
  },
  network: {
    label: 'Network-support',
    blurb: 'Charge at feeder minimum, discharge at feeder peak. What the network operator would ask for.'
  }
};

/* ------------------------------------------------------------------ *
 * The battery on the network
 * ------------------------------------------------------------------ */

/**
 * A grid-scale battery is a current source behind an inverter, so on a PQ bus
 * it is simply a scheduled injection - positive discharging, negative charging.
 * Reactive output is left at zero: GB grid-scale storage normally runs close to
 * unity power factor unless it is contracted for reactive support, and letting
 * it hold voltage instead would flatter every result on this page.
 */
export function withBattery(net, { bus, mw }) {
  if (!bus || !mw) return net;
  return { ...net, gen: [...net.gen, { bus, pg: mw, qg: 0, qmax: 0, qmin: 0, vg: 1, status: 1 }] };
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

/** Indices of the n smallest values in a series, and of the n largest. */
function extremes(series, n) {
  const order = series.map((value, i) => ({ value, i })).sort((a, b) => a.value - b.value);
  return {
    low: new Set(order.slice(0, n).map(entry => entry.i)),
    high: new Set(order.slice(-n).map(entry => entry.i))
  };
}

/**
 * How hard each rule is willing to charge, as a fraction of rated power.
 *
 * A merchant battery charges flat out in the cheapest half-hours, because the
 * price signal is all it sees. A network operator would not: charging is load,
 * and a full-rated draw at a weak point on the feeder is the same problem the
 * battery was bought to solve, only pointing the other way. Network-support
 * therefore charges at half power over twice as long - same energy, a quarter
 * of the loss, and far less voltage drop.
 */
const CHARGE_FRACTION = { price: 1, carbon: 1, network: 0.5 };

/**
 * Turn a rule into a half-hourly setpoint in MW, positive discharging.
 *
 * The rule only says which half-hours to aim at. State of charge is then walked
 * forward through the window in order and clips whatever is not physically
 * available, which is why a rule that wants to discharge before it has charged
 * delivers less rather than producing free energy.
 */
export function scheduleBattery({ price, carbon, demand, powerMw, energyMwh, mode }) {
  const setpoints = new Float64Array(SLOTS);
  if (!powerMw || !energyMwh) return { setpoints, chargedMwh: 0, dischargedMwh: 0 };

  const signal = mode === 'price' ? price : mode === 'carbon' ? carbon : demand;
  const fraction = CHARGE_FRACTION[mode] ?? 1;
  const chargeMw = powerMw * fraction;

  // Half-hours at rated power to move a full charge, and the longer, gentler
  // window the charge is spread over.
  const cap = Math.floor(SLOTS / 2);
  const span = Math.max(1, Math.min(cap, Math.round(energyMwh / (powerMw * HOURS_PER_SLOT))));
  const chargeSpan = Math.max(1, Math.min(cap, Math.round(span / fraction)));

  const low = extremes(signal, chargeSpan).low;
  const high = extremes(signal, span).high;

  // Walk the window in order, clipping whatever state of charge cannot supply.
  const walk = (limitDischarge = 1, limitCharge = 1) => {
    let soc = energyMwh / 2;
    let chargedMwh = 0;
    let dischargedMwh = 0;

    for (let i = 0; i < SLOTS; i++) {
      if (high.has(i)) {
        // Discharging draws more out of the cell than it puts on the network.
        const room = (soc * ONE_WAY) / HOURS_PER_SLOT;
        const mw = Math.min(powerMw * limitDischarge, Math.max(0, room));
        setpoints[i] = mw;
        soc -= (mw * HOURS_PER_SLOT) / ONE_WAY;
        dischargedMwh += mw * HOURS_PER_SLOT;
      } else if (low.has(i)) {
        const room = (energyMwh - soc) / (ONE_WAY * HOURS_PER_SLOT);
        const mw = Math.min(chargeMw * limitCharge, Math.max(0, room));
        setpoints[i] = -mw;
        soc += mw * HOURS_PER_SLOT * ONE_WAY;
        chargedMwh += mw * HOURS_PER_SLOT;
      } else {
        setpoints[i] = 0;
      }
    }

    return { soc, chargedMwh, dischargedMwh };
  };

  // The window has to close on itself. Left alone, a battery that starts half
  // full and ends empty would appear to deliver energy nobody charged - which
  // would quietly inflate both the trading revenue and the carbon saving. So
  // whichever direction ran longer is scaled back until the cell ends the
  // window where it started, and the round trip is genuinely paid for.
  //
  // It has to be solved rather than estimated: scaling one direction changes
  // how much headroom the other has, so a single correction overshoots. The
  // imbalance is monotonic in the limiter, so bisection settles it.
  const imbalance = pass => pass.dischargedMwh / ONE_WAY - pass.chargedMwh * ONE_WAY;

  let pass = walk();
  const drift = imbalance(pass);

  if (Math.abs(drift) > 1e-9) {
    // Throttle whichever direction ran long; the other keeps full freedom.
    const trimDischarge = drift > 0;
    let lo = 0;
    let hi = 1;

    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      const trial = trimDischarge ? walk(mid, 1) : walk(1, mid);
      const off = imbalance(trial);
      if (Math.abs(off) < 1e-12) { lo = hi = mid; break; }
      // Trimming discharge lowers the imbalance; trimming charge raises it.
      if (trimDischarge === off > 0) hi = mid;
      else lo = mid;
    }

    pass = trimDischarge ? walk(hi, 1) : walk(1, hi);
  }

  return {
    setpoints,
    chargedMwh: pass.chargedMwh,
    dischargedMwh: pass.dischargedMwh,
    endSoc: pass.soc,
    chargeMw,
    span,
    chargeSpan
  };
}

/* ------------------------------------------------------------------ *
 * Electrical assessment
 * ------------------------------------------------------------------ */

/** Head of the feeder: the branch leaving the primary substation. */
export function headIndex(net) {
  return net.branch.findIndex(branch => branch.from === net.bus[0].id);
}

export function snapshot(net, loadScale) {
  const result = solvePowerFlow(net, { loadScale });
  if (!result.converged) return null;

  const vms = result.buses.map(bus => bus.vm);
  const lowest = Math.min(...vms);
  const rated = result.branches.filter(flow => !flow.out && flow.rating);

  return {
    result,
    vmin: lowest,
    vmax: Math.max(...vms),
    vminBus: result.buses[vms.indexOf(lowest)].id,
    worstLoading: rated.length ? Math.max(...rated.map(flow => flow.loading)) : 0,
    lossesMw: result.lossesMw,
    headMw: result.branches[headIndex(net)]?.pFrom ?? 0,
    violations: violations(result)
  };
}

function argmin(series, pick) {
  return series.reduce((best, s, i) => (pick(s) < pick(series[best]) ? i : best), 0);
}

function argmax(series, pick) {
  return series.reduce((best, s, i) => (pick(s) > pick(series[best]) ? i : best), 0);
}

function gather(series) {
  const worstV = argmin(series, s => s.vmin);
  const worstLoad = argmax(series, s => s.worstLoading);

  return {
    vmin: series[worstV].vmin,
    vminBus: series[worstV].vminBus,
    vminSlot: worstV,
    vmax: Math.max(...series.map(s => s.vmax)),
    worstLoading: series[worstLoad].worstLoading,
    worstLoadingSlot: worstLoad,
    lossesMwh: series.reduce((sum, s) => sum + s.lossesMw * HOURS_PER_SLOT, 0),
    peakHeadMw: Math.max(...series.map(s => s.headMw)),
    minHeadMw: Math.min(...series.map(s => s.headMw)),
    voltageBreaches: series.filter(s => s.violations.voltage.length).length,
    overloads: series.filter(s => s.violations.overload.length).length
  };
}

/**
 * Solve the feeder for every half-hour of the window, with the battery and
 * without it. Ninety-six power flows; a few hundred milliseconds.
 */
/**
 * The feeder without any battery, half-hour by half-hour. Depends only on the
 * demand window, so the page solves it once when the live data arrives and
 * hands it back on every control change - which halves the work per redraw.
 */
export function baseline(net, demandScale) {
  return Array.from({ length: SLOTS }, (_, i) => snapshot(net, demandScale[i]));
}

export function assess(net, { bus, setpoints, demandScale, baseSeries = null }) {
  const withOut = baseSeries ?? baseline(net, demandScale);
  const withBat = [];

  for (let i = 0; i < SLOTS; i++) {
    const live = snapshot(withBattery(net, { bus, mw: setpoints[i] }), demandScale[i]);
    withBat.push(live ?? withOut[i]);
  }

  // The half-hour of highest demand: the one the network is planned around, and
  // the one where the battery is supposed to earn its place.
  const peakSlot = argmax(demandScale.map(scale => ({ scale })), s => s.scale);

  return {
    base: gather(withOut),
    withBattery: gather(withBat),
    peakSlot,
    atPeak: {
      base: withOut[peakSlot].vmin,
      withBattery: withBat[peakSlot].vmin,
      setpointMw: setpoints[peakSlot]
    },
    series: { base: withOut, withBattery: withBat },
    lossSeriesMw: withBat.map((s, i) => withOut[i].lossesMw - s.lossesMw)
  };
}

/* ------------------------------------------------------------------ *
 * What it is worth, and what it emits
 * ------------------------------------------------------------------ */

/**
 * Two separate ledgers, deliberately not added together.
 *
 * Losses avoided and peak reduced accrue to the network operator. Arbitrage
 * accrues to whoever owns the battery, and in GB that is almost never the
 * network operator - a DNO buys flexibility, it does not trade. Presenting one
 * total would imply a party that does not exist.
 */
export function value({ assessment, setpoints, price, carbon, energyMwh }) {
  const lossMwhSaved = assessment.base.lossesMwh - assessment.withBattery.lossesMwh;

  let lossValue = 0;
  let lossCarbonKg = 0;
  let arbitrage = 0;
  let operationalKg = 0;
  let dischargedMwh = 0;

  for (let i = 0; i < SLOTS; i++) {
    const savedMwh = assessment.lossSeriesMw[i] * HOURS_PER_SLOT;
    lossValue += savedMwh * price[i];
    lossCarbonKg += savedMwh * carbon[i];          // gCO2/kWh x MWh = kg

    const mwh = setpoints[i] * HOURS_PER_SLOT;      // + discharged, - charged
    arbitrage += mwh * price[i];
    operationalKg -= mwh * carbon[i];               // charging adds, discharging avoids
    if (mwh > 0) dischargedMwh += mwh;
  }

  const embodiedKgPerDay = {
    low: (energyMwh * 1000 * EMBODIED_KG_PER_KWH.low) / (ASSET_LIFE_YEARS * 365),
    high: (energyMwh * 1000 * EMBODIED_KG_PER_KWH.high) / (ASSET_LIFE_YEARS * 365)
  };

  return {
    lossMwhSaved,
    lossValue,
    lossCarbonKg,
    arbitrage,
    operationalKg,
    // The two things that actually move day to day, netted.
    netOperationalKg: operationalKg - lossCarbonKg,
    embodiedKgPerDay,
    peakReducedMw: assessment.base.peakHeadMw - assessment.withBattery.peakHeadMw,
    // The same energy delivered by a standby diesel set instead.
    dieselKg: dischargedMwh * 1000 * DIESEL_KG_PER_KWH,
    dischargedMwh
  };
}

/* ------------------------------------------------------------------ *
 * The recommendation
 * ------------------------------------------------------------------ */

export const fmtGbp = value => {
  // Round before testing the sign, so a value that rounds to nothing prints as
  // "£0" rather than the nonsense "-£0".
  const rounded = Math.round(value);
  const shown = Math.abs(rounded).toLocaleString('en-GB', { maximumFractionDigits: 0 });
  return `${rounded < 0 ? '−' : ''}£${shown}`;
};

/**
 * A single verdict with the constraint that decided it named, rather than a
 * score. A planner needs to know what is binding, not how many points it got.
 */
export function verdict({ assessment, worth, net, setpoints }) {
  const before = assessment.base;
  const after = assessment.withBattery;
  const band = { min: net.bus[1].vmin, max: net.bus[1].vmax };
  const pct = share => `${(share * 100).toFixed(share < 0.1 ? 1 : 0)} per cent`;

  const lossShare = before.lossesMwh ? worth.lossMwhSaved / before.lossesMwh : 0;
  const exports = after.minHeadMw < 0;

  // Was the worst half-hour one where the battery was drawing power? That is a
  // different failure from a battery that is simply too big to discharge here,
  // and it has a different fix, so the two are never merged.
  const chargingAtWorstV = setpoints[after.vminSlot] < -1e-9;
  const chargingAtWorstLoad = setpoints[after.worstLoadingSlot] < -1e-9;

  const peakGain = assessment.atPeak.withBattery - assessment.atPeak.base;
  const helpsAtPeak = peakGain > 0.0005;
  const peakLine = helpsAtPeak
    ? `At the demand peak it does what it was bought for: bus ${after.vminBus} rises from `
      + `${assessment.atPeak.base.toFixed(3)} to ${assessment.atPeak.withBattery.toFixed(3)} pu. `
    : '';

  if (after.worstLoading > 1 && before.worstLoading <= 1) {
    return {
      level: 'no',
      headline: 'Not recommended at this size',
      reason: peakLine
        + `But a circuit reaches ${(after.worstLoading * 100).toFixed(0)} per cent of rating `
        + `while the battery is ${chargingAtWorstLoad ? 'charging' : 'discharging'}. `
        + 'Thermal capacity is binding, and reinforcing it would cost more than the battery saves.',
      binding: 'Thermal rating'
    };
  }

  if (after.vmin < before.vmin - 0.002) {
    return {
      level: 'no',
      headline: 'Not recommended at this size',
      reason: peakLine
        + `But the worst half-hour on the feeder gets worse, not better: ${before.vmin.toFixed(3)} pu `
        + `becomes ${after.vmin.toFixed(3)} pu at bus ${after.vminBus}`
        + (chargingAtWorstV
          ? ', because charging at rated power puts the whole draw at the weakest point on the network. '
            + 'A battery is a load half the time, and this siting cannot absorb it. Reduce the power rating.'
          : '. The injection is too large for this point on the feeder.'),
      binding: chargingAtWorstV ? 'Voltage while charging' : 'Voltage'
    };
  }

  if (after.vmax > band.max && before.vmax <= band.max) {
    return {
      level: 'no',
      headline: 'Not recommended at this size',
      reason: `Discharging lifts a bus to ${after.vmax.toFixed(3)} pu, above the ${band.max} pu limit. `
        + 'Voltage rise is binding: the injection is too large for this point on the feeder.',
      binding: 'Voltage rise'
    };
  }

  if (before.vmin < band.min && after.vmin >= band.min) {
    return {
      level: 'yes',
      headline: 'Recommended',
      reason: `The feeder breached the ${band.min} pu statutory limit in `
        + `${before.voltageBreaches} half-hour${before.voltageBreaches === 1 ? '' : 's'}, worst `
        + `${before.vmin.toFixed(3)} pu at bus ${before.vminBus}. With the battery every half-hour is `
        + `inside the band and losses fall ${pct(lossShare)}.`,
      binding: 'None - the constraint clears'
    };
  }

  if (after.vmin < band.min) {
    return {
      level: 'partial',
      headline: 'Helps, but does not clear the constraint',
      reason: peakLine
        + `The worst half-hour still sits at ${after.vmin.toFixed(3)} pu at bus ${after.vminBus}, below the `
        + `${band.min} pu limit. Voltage remains binding: more power, or a second site, would be needed.`,
      binding: 'Voltage at peak'
    };
  }

  if (worth.lossMwhSaved < 0) {
    return {
      level: 'partial',
      headline: 'No limit breached, but the network pays for it',
      reason: `Nothing is outside its limits, and the battery earns ${fmtGbp(worth.arbitrage)} trading. `
        + `But it raises total feeder losses by ${Math.abs(worth.lossMwhSaved * 1000).toFixed(0)} kWh over the `
        + 'window, because it draws current twice - once to charge and once to discharge - and losses go as '
        + 'the square of it. The trade is profitable for the owner and slightly negative for the network.',
      binding: 'None - but losses rise'
    };
  }

  if (lossShare > 0.05) {
    return {
      level: 'yes',
      headline: 'Recommended',
      reason: `Nothing is binding, so this is an efficiency case rather than a constraint case: losses fall `
        + `${pct(lossShare)}, worth ${fmtGbp(worth.lossValue)} over the window.`
        + (exports
          ? ' The feeder does export to the grid in some half-hours, which is a connection question rather '
            + 'than a limit breach.'
          : ''),
      binding: 'None'
    };
  }

  return {
    level: 'marginal',
    headline: 'Little benefit at this location',
    reason: `Nothing is binding and losses move only ${pct(lossShare)}. Close to the primary substation a `
      + 'battery has almost no network to relieve - the current it displaces never travelled far enough to '
      + 'lose anything. The same asset further down the feeder does considerably more.',
    binding: 'None'
  };
}
