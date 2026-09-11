// scripts/build-site-case.mjs
//
// Builds data/site-warehouse.json: everything the "Does resilience change the
// investment?" demonstration runs on, frozen into one file so the page gives
// the same answer every time it is opened.
//
// Two kinds of input, kept visibly apart in the output:
//
//   sourced   - fetched or transcribed from a named publication: PVGIS solar and
//               temperature, half-hourly GB grid carbon, DESNZ conversion
//               factors and prices, published cost and embodied-carbon figures.
//   assumed   - the warehouse itself, which is synthetic, and the handful of
//               costs no public source pins down for a site of this size.
//
// Weather, solar output and grid carbon all come from the same year, 2023, and
// the same days, so any correlation between them is the real one rather than
// one constructed here.
//
// Run with: npm run build:site     Validate with: node --test tests/site.test.js

import { writeFile } from 'node:fs/promises';

const SLOTS = 48;
const DT = 0.5;                 // hours per slot
const YEAR = 2023;

/* ------------------------------------------------------------------ *
 * The site
 * ------------------------------------------------------------------ */

// Daventry, in the Midlands logistics "golden triangle" where much of the UK's
// warehousing sits. Roof-mounted PV, 10 degree tilt, due south, 14% losses -
// PVGIS's default system loss.
const SITE = { name: 'Representative distribution warehouse', town: 'Daventry, Northamptonshire', lat: 52.26, lon: -1.16 };

// The warehouse is synthetic. Every number here is an assumption, stated once
// and used everywhere, so that the recipe can be read and argued with.
const RECIPE = {
  opsDayKw: 380,          // lighting, conveyors, MHE charging, ventilation: 06:00-22:00
  opsNightKw: 140,        // the same overnight
  coldRefKw: 150,         // cold-store refrigeration at 15 degC ambient
  coldPerDegC: 0.03,      // +3% per degC: midpoint of the 2-4% per degC of condensing temperature (Carbon Trust)
  coldFloorFrac: 0.7,     // refrigeration never falls below 70% of its reference load
  itKw: 35,               // IT, warehouse management system, security, emergency lighting
  heatUaKwPerK: 60,       // whole-building heat loss coefficient
  heatSetC: 15.5,         // occupied set point, 06:00-22:00
  heatSetbackC: 10,       // overnight set-back
  boilerEff: 0.88,        // existing gas boilers, seasonal efficiency
  copBase: 2.6,           // air-source heat pump COP = 2.6 + 0.06 x ambient degC, clamped 2.2-4.0
  copSlope: 0.06,
  copMin: 2.2,
  copMax: 4.0,
  vans: 30,
  kmPerVanDay: 160,
  evKwhPerKm: 0.30,       // large battery-electric van, typical manufacturer figure
  evChargeFrom: 18,       // vans return and charge 18:00-04:00, managed to a flat rate
  evChargeHours: 10,
  pf: { ops: 0.95, cold: 0.90, it: 0.98, hp: 0.97, ev: 0.99 }
};

const cop = t => Math.min(RECIPE.copMax, Math.max(RECIPE.copMin, RECIPE.copBase + RECIPE.copSlope * t));

/* ------------------------------------------------------------------ *
 * Sourced constants
 * ------------------------------------------------------------------ */

const DESNZ_FACTORS = 'https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2026';
const DESNZ_PRICES = 'https://www.gov.uk/government/statistical-data-sets/gas-and-electricity-prices-in-the-non-domestic-sector';

const FACTORS = {
  electricityKg: 0.13096,      // UK electricity generated, kg CO2e/kWh, 2026
  tdKg: 0.01299,               // T&D losses, UK electricity, 2026
  wttGenerationKg: 0.03682,    // WTT, UK electricity generation, 2026
  wttTdKg: 0.00359,            // WTT, UK electricity T&D, 2026
  gasKg: 0.18231,              // natural gas, kWh (gross CV), 2026
  wttGasKg: 0.03021,           // WTT natural gas, kWh (gross CV), 2026
  dieselKgPerLitre: 2.58354,   // diesel (average biofuel blend), litres, 2026
  wttDieselKgPerLitre: 0.61101,
  vanKgPerKm: 0.25716          // van, average up to 3.5 t, diesel, 2026
};

const PRICES = {
  electricityAvgGbpPerKwh: 0.25358,   // DESNZ Table 3.4.1, 2025, Electricity: Medium (2,000-19,999 MWh), excl. CCL
  gasSmallGbpPerKwh: 0.04645,         // DESNZ Table 3.4.1, 2025, Gas: Small (278-2,777 MWh), excl. CCL
  gasMediumGbpPerKwh: 0.04315,        // DESNZ Table 3.4.1, 2025, Gas: Medium (2,778-27,777 MWh), excl. CCL
  cclGbpPerKwh: 0.00801,              // Climate Change Levy from 1 April 2026, electricity and gas (same table, notes)
  dieselGbpPerLitre: 1.5530,          // DESNZ weekly road fuel prices, w/c 7 Sep 2026: 186.36p incl. 20% VAT
  exportGbpPerKwh: 0.05,              // assumed
  // Time-of-use shape, relative to the average. Assumed; scaled below so the
  // existing site's average unit rate equals the DESNZ figure exactly.
  bandShape: { green: 0.75, amber: 1.0, red: 1.8 }
};

const COSTS = {
  pvGbpPerKwp: 850,            // assumed, between the two DESNZ-published bounds below
  pvOmGbpPerKwpYr: 6.1,        // Arup for DESNZ (2025), Table 4, large-scale solar O&M, medium case
  pvLifeYears: 35,             // same table, operating lifetime, medium case
  batteryGbpPerKwh: 300,       // assumed: energy component
  batteryGbpPerKw: 200,        // assumed: power component; together they land inside the UK installer range
  batteryOmFrac: 0.025,        // NREL ATB 2024, commercial battery storage: fixed O&M 2.5% of capital cost
  batteryLifeYears: 15,        // assumed
  islandingGbp: 60000,         // assumed: grid-forming conversion, transfer switchgear, G99 islanding protection
  generatorGbpPerKw: 350,      // assumed, installed with automatic transfer switch
  generatorOmFrac: 0.02,       // assumed
  generatorLifeYears: 25,      // assumed
  generatorTestHoursYr: 12,    // assumed: an hour a month at half load
  generatorLitresPerKwh: 0.27  // assumed
};

const EMBODIED = {
  pvKgPerKwp: 810,             // Müller et al. (2021): glass-backsheet module made in China, production stage
  batteryKgPerKwh: 62          // Peiseler et al. (2024): LFP cells, median, cradle-to-gate - cells only
};

const FINANCE = { discountRate: 0.07, years: 20 };           // assumed, real terms
const TARGET = { scope12CutFrac: 0.5 };                      // assumed: Scope 1+2 at least 50% below today
const VOLL_GBP_PER_KWH = 17;                                 // £17,000/MWh, London Economics for Ofgem (2013)
const PF_PLAN = 0.95;                                        // site power factor used to turn kVA limits into kW

const CONNECTIONS = {
  today: { label: '800 kVA today', ascKva: 800, transformerKva: 1000 },
  reinforced: { label: '1,200 kVA after reinforcement', ascKva: 1200, transformerKva: 1250 }
};

/* ------------------------------------------------------------------ *
 * Time: PVGIS is hourly UTC, the tariff is on the local clock
 * ------------------------------------------------------------------ */

// British Summer Time in 2023 ran from 26 March to 29 October; both change-over
// days are Sundays, and only weekdays are used, so no day here has 23 or 25 hours.
const bst = date => date >= Date.UTC(YEAR, 2, 26) && date < Date.UTC(YEAR, 9, 29);
const DAY_MS = 86400000;
const SLOT_MS = 1800000;

function band(slot) {
  const hour = slot / 2;
  if (hour >= 16 && hour < 19) return 'red';
  if ((hour >= 7 && hour < 16) || (hour >= 19 && hour < 23)) return 'amber';
  return 'green';
}

/* ------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------ */

async function json(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return await response.json();
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
    }
  }
}

async function pvgis() {
  const url = 'https://re.jrc.ec.europa.eu/api/v5_3/seriescalc'
    + `?lat=${SITE.lat}&lon=${SITE.lon}&pvcalculation=1&peakpower=1&loss=14&angle=10&aspect=0`
    + `&startyear=${YEAR}&endyear=${YEAR}&outputformat=json`;
  const payload = await json(url);
  const hourly = new Map();
  for (const row of payload.outputs.hourly) {
    const [date, time] = row.time.split(':');
    const key = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +time.slice(0, 2));
    hourly.set(key, { kwPerKwp: row.P / 1000, tempC: row.T2m });
  }
  return { url, hourly };
}

/** One local-clock day, as 48 half-hours of PV output per kWp and ambient temperature. */
function localDay(hourly, dayUtc) {
  const offset = bst(dayUtc) ? 3600000 : 0;
  const pv = [];
  const temp = [];
  for (let k = 0; k < SLOTS; k++) {
    const utc = dayUtc + k * SLOT_MS - offset;
    const hour = hourly.get(utc - (utc % 3600000));
    if (!hour) throw new Error(`PVGIS has no hour for ${new Date(utc).toISOString()}`);
    pv.push(+hour.kwPerKwp.toFixed(4));
    temp.push(+hour.tempC.toFixed(2));
  }
  return { pv, temp };
}

async function carbon(dayUtc) {
  const offset = bst(dayUtc) ? 3600000 : 0;
  const first = dayUtc - offset;
  const stamp = ms => new Date(ms).toISOString().slice(0, 16) + 'Z';
  // The API's end bound is exclusive and its start snaps to the enclosing
  // period, so ask for one period either side and pick by exact timestamp.
  const url = `https://api.carbonintensity.org.uk/intensity/${stamp(first - SLOT_MS)}/${stamp(first + (SLOTS + 1) * SLOT_MS)}`;
  const rows = (await json(url)).data;
  const byFrom = new Map(rows.map(row => [row.from, row.intensity.actual ?? row.intensity.forecast]));
  const series = Array.from({ length: SLOTS }, (_, k) => byFrom.get(stamp(first + k * SLOT_MS)));
  if (series.some(v => v == null)) throw new Error(`carbon intensity incomplete for ${stamp(first)}`);
  return series;
}

/* ------------------------------------------------------------------ *
 * The day's loads
 * ------------------------------------------------------------------ */

function loads(temp) {
  const ops = [];
  const cold = [];
  const it = [];
  const heat = [];
  const hp = [];
  const gas = [];
  const ev = [];
  const evKw = (RECIPE.vans * RECIPE.kmPerVanDay * RECIPE.evKwhPerKm) / RECIPE.evChargeHours;

  for (let k = 0; k < SLOTS; k++) {
    const hour = k / 2;
    const occupied = hour >= 6 && hour < 22;
    const t = temp[k];

    ops.push(occupied ? RECIPE.opsDayKw : RECIPE.opsNightKw);
    cold.push(+Math.max(RECIPE.coldRefKw * RECIPE.coldFloorFrac,
      RECIPE.coldRefKw * (1 + RECIPE.coldPerDegC * (t - 15))).toFixed(2));
    it.push(RECIPE.itKw);

    const thermal = RECIPE.heatUaKwPerK * Math.max(0, (occupied ? RECIPE.heatSetC : RECIPE.heatSetbackC) - t);
    heat.push(+thermal.toFixed(2));
    hp.push(+(thermal / cop(t)).toFixed(2));
    gas.push(+(thermal / RECIPE.boilerEff).toFixed(2));

    const sinceStart = (hour - RECIPE.evChargeFrom + 24) % 24;
    ev.push(sinceStart < RECIPE.evChargeHours ? +evKw.toFixed(2) : 0);
  }
  return { ops, cold, it, heat, hp, gas, ev };
}

/* ------------------------------------------------------------------ *
 * The site network
 * ------------------------------------------------------------------ */

// Copper XLPE four-core cable, representative per-km impedance and rating at
// 400 V. Parallel runs divide the impedance and multiply the rating.
const CABLE = {
  70: { r: 0.342, x: 0.075, kva: 130 },
  185: { r: 0.128, x: 0.073, kva: 263 },
  300: { r: 0.080, x: 0.072, kva: 353 }
};
const Z_BASE_LV = 0.4 * 0.4 / 1;          // ohm, 400 V on a 1 MVA base

function cable(from, to, size, metres, runs = 1) {
  const c = CABLE[size];
  return {
    from, to, name: `${runs > 1 ? `${runs} x ` : ''}${size} mm², ${metres} m`,
    r: +((c.r * metres / 1000 / runs) / Z_BASE_LV).toFixed(6),
    x: +((c.x * metres / 1000 / runs) / Z_BASE_LV).toFixed(6),
    b: 0, ratio: 0, shift: 0, status: 1,
    rateA: +((c.kva * runs) / 1000).toFixed(4)
  };
}

function network() {
  const bus = (id, type, name, board) => ({ id, type, pd: 0, qd: 0, gs: 0, bs: 0, vmax: 1.10, vmin: 0.94, name, board });
  return {
    name: 'Warehouse site network',
    baseMVA: 1,
    sourceVoltagePu: 1.04,
    bus: [
      bus(1, 3, 'Point of connection, 11 kV', null),
      bus(2, 1, 'LV main switchboard', null),
      bus(3, 1, 'Cold store', 'cold'),
      bus(4, 1, 'IT and safety', 'it'),
      bus(5, 1, 'Warehouse operations', 'ops'),
      bus(6, 1, 'Heat pump plant', 'hp'),
      bus(7, 1, 'EV depot', 'ev'),
      bus(8, 1, 'Roof PV', 'pv'),
      bus(9, 1, 'Battery', 'battery')
    ],
    // The transformer is filled in per connection scenario by the engine.
    transformer: { from: 1, to: 2, impedancePu: 0.05, xOverR: 6 },
    cables: [
      cable(2, 3, 300, 60),
      cable(2, 4, 70, 40),
      cable(2, 5, 300, 80, 2),
      cable(2, 6, 300, 90),
      cable(2, 7, 185, 150),
      cable(2, 8, 300, 70, 3),
      cable(2, 9, 300, 20, 2)
    ]
  };
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

const median = xs => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))) || 1; };

const { url: pvgisUrl, hourly } = await pvgis();

// Every weekday of the year, summarised.
const weekdays = [];
for (let t = Date.UTC(YEAR, 0, 1); t < Date.UTC(YEAR + 1, 0, 1); t += DAY_MS) {
  const dow = new Date(t).getUTCDay();
  if (dow === 0 || dow === 6) continue;
  const { pv, temp } = localDay(hourly, t);
  weekdays.push({ t, pv, temp, pvKwh: pv.reduce((a, b) => a + b, 0) * DT, tMean: mean(temp), tMax: Math.max(...temp) });
}

// One typical weekday per month - closest to that month's median solar yield
// and mean temperature - weighted by the days in the month.
const reps = [];
for (let m = 0; m < 12; m++) {
  const month = weekdays.filter(d => new Date(d.t).getUTCMonth() === m);
  const mp = median(month.map(d => d.pvKwh));
  const mt = median(month.map(d => d.tMean));
  const sp = sd(month.map(d => d.pvKwh));
  const st = sd(month.map(d => d.tMean));
  const best = month.reduce((a, d) =>
    ((d.pvKwh - mp) / sp) ** 2 + ((d.tMean - mt) / st) ** 2 < ((a.pvKwh - mp) / sp) ** 2 + ((a.tMean - mt) / st) ** 2 ? d : a);
  reps.push({ ...best, weight: new Date(Date.UTC(YEAR, m + 1, 0)).getUTCDate() });
}

// The two outage scenarios. Correlated: the hottest weekday of the year, when
// refrigeration is working hardest. Independent: the representative day nearest
// the year's mean temperature, standing for "an outage on an ordinary day".
const hottest = weekdays.reduce((a, d) => (d.tMax > a.tMax ? d : a));
const annualMean = reps.reduce((s, d) => s + d.tMean * d.weight, 0) / 365;
const typical = reps.reduce((a, d) => (Math.abs(d.tMean - annualMean) < Math.abs(a.tMean - annualMean) ? d : a));

async function dayRecord(d, weight) {
  return {
    date: new Date(d.t).toISOString().slice(0, 10),
    weekday: new Date(d.t).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }),
    weight,
    tMean: +d.tMean.toFixed(2),
    tMax: +d.tMax.toFixed(2),
    pvPerKwp: d.pv,
    temp: d.temp,
    carbon: await carbon(d.t),
    band: Array.from({ length: SLOTS }, (_, k) => band(k)),
    load: loads(d.temp)
  };
}

const days = [];
for (const d of reps) days.push(await dayRecord(d, d.weight));
const scenarios = {
  independent: { ...(await dayRecord(typical, 0)), label: 'Independent', blurb: 'An outage on an ordinary day: the representative day closest to the year\'s mean temperature.' },
  correlated: { ...(await dayRecord(hottest, 0)), label: 'Correlated', blurb: 'An outage on the hottest weekday of 2023, when heat stress on the network and the cold store\'s refrigeration load peak together.' }
};

// Calibrate the tariff so the existing site's load-weighted average unit rate
// is exactly the DESNZ medium-band average.
let kwh = 0;
const bandKwh = { green: 0, amber: 0, red: 0 };
for (const d of days) {
  for (let k = 0; k < SLOTS; k++) {
    const e = (d.load.ops[k] + d.load.cold[k] + d.load.it[k]) * DT * d.weight;
    kwh += e;
    bandKwh[d.band[k]] += e;
  }
}
const shapeAvg = Object.entries(bandKwh).reduce((s, [b, e]) => s + PRICES.bandShape[b] * e, 0) / kwh;
const bandPrice = Object.fromEntries(Object.keys(PRICES.bandShape)
  .map(b => [b, +(PRICES.bandShape[b] * PRICES.electricityAvgGbpPerKwh / shapeAvg).toFixed(5)]));

// Gas band follows the existing site's consumption.
const gasKwh = days.reduce((s, d) => s + d.load.gas.reduce((a, g) => a + g, 0) * DT * d.weight, 0);
const gasPrice = gasKwh / 1000 <= 2777 ? PRICES.gasSmallGbpPerKwh : PRICES.gasMediumGbpPerKwh;

const out = {
  name: 'Does resilience change the investment? - site case',
  built: 'Run scripts/build-site-case.mjs to rebuild. Weather, solar and grid carbon are 2023; prices, factors and costs are the latest published at build time.',
  site: SITE,
  recipe: RECIPE,
  slots: SLOTS,
  hoursPerSlot: DT,
  days,
  scenarios,
  connections: CONNECTIONS,
  pfPlan: PF_PLAN,
  factors: FACTORS,
  prices: {
    bandGbpPerKwh: bandPrice,
    cclGbpPerKwh: PRICES.cclGbpPerKwh,
    gasGbpPerKwh: gasPrice,
    dieselGbpPerLitre: PRICES.dieselGbpPerLitre,
    exportGbpPerKwh: PRICES.exportGbpPerKwh,
    electricityAvgGbpPerKwh: PRICES.electricityAvgGbpPerKwh,
    bandShape: PRICES.bandShape
  },
  costs: COSTS,
  embodied: EMBODIED,
  finance: FINANCE,
  target: TARGET,
  vollGbpPerKwh: VOLL_GBP_PER_KWH,
  network: network(),
  sources: [
    { id: 'pvgis', kind: 'sourced', label: 'PVGIS 5.3 (European Commission JRC), hourly PV output and 2 m temperature, 2023', url: pvgisUrl.replace(/&outputformat=json$/, '') },
    { id: 'carbon', kind: 'sourced', label: 'National Energy System Operator Carbon Intensity API, GB half-hourly actual intensity, 2023', url: 'https://carbonintensity.org.uk/' },
    { id: 'factors', kind: 'sourced', label: 'DESNZ, Greenhouse gas reporting: conversion factors 2026 (full set)', url: DESNZ_FACTORS },
    { id: 'prices', kind: 'sourced', label: 'DESNZ, Quarterly Energy Prices Table 3.4.1, non-domestic prices, 2025 (and CCL rates)', url: DESNZ_PRICES },
    { id: 'diesel', kind: 'sourced', label: 'DESNZ, Weekly road fuel prices, week commencing 7 September 2026', url: 'https://www.gov.uk/government/statistics/weekly-road-fuel-prices' },
    { id: 'solar-small', kind: 'sourced', label: 'DESNZ, Solar PV cost data 2025/26: non-domestic 10-50 kW, mean £1,167/kW (upper bound used)', url: 'https://www.gov.uk/government/statistics/solar-pv-cost-data' },
    { id: 'solar-large', kind: 'sourced', label: 'Arup for DESNZ (2025), Renewable Energy Generation Cost and Technical Assumptions: solar PV >5 MW, total capex £659/kWp (lower bound used), O&M and lifetime', url: 'https://www.gov.uk/government/publications/onshore-wind-and-solar-cost-and-technical-assumptions' },
    { id: 'battery-om', kind: 'sourced', label: 'NREL Annual Technology Baseline 2024, commercial battery storage: fixed O&M 2.5% of capital cost', url: 'https://atb.nrel.gov/electricity/2024/commercial_battery_storage' },
    { id: 'battery-capex', kind: 'assumed', label: 'Battery capital cost: £300/kWh + £200/kW, set inside the £350-550/kWh range UK installer guides quote for systems above 1 MWh (2026)', url: null },
    { id: 'pv-embodied', kind: 'sourced', label: 'Müller et al. (2021), Solar Energy Materials and Solar Cells 230 - 810 kg CO2e/kWp, China-made glass-backsheet module (Fraunhofer ISE)', url: 'https://www.ise.fraunhofer.de/en/press-media/press-releases/2021/european-glass-glass-photovoltaic-modules-are-particularly-climate-friendly.html' },
    { id: 'battery-embodied', kind: 'sourced', label: 'Peiseler et al. (2024), Nature Communications - LFP cells 62 kg CO2e/kWh (median, cradle-to-gate)', url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC11603021/' },
    { id: 'refrigeration', kind: 'sourced', label: 'Compressor energy +2-4% per degC of condensing temperature (Carbon Trust, cited in Frontiers in Sustainable Food Systems, 2023)', url: 'https://www.frontiersin.org/journals/sustainable-food-systems/articles/10.3389/fsufs.2023.1250646/full' },
    { id: 'voll', kind: 'sourced', label: 'Value of lost load £17,000/MWh, London Economics for Ofgem (2013), used in the GB reliability standard', url: 'https://ofgem.gov.uk/ofgem-publications/82293/london-economics-value-lost-load-electricity-gbpdf' }
  ]
};

await writeFile(new URL('../data/site-warehouse.json', import.meta.url), `${JSON.stringify(out)}\n`);

const elecKwh = days.reduce((s, d) => s + d.load.ops.reduce((a, _, k) => a + d.load.ops[k] + d.load.cold[k] + d.load.it[k], 0) * DT * d.weight, 0);
console.log('representative weekdays:', days.map(d => `${d.date} (${d.weight})`).join(', '));
console.log('independent scenario:', scenarios.independent.date, `mean ${scenarios.independent.tMean} degC`);
console.log('correlated scenario: ', scenarios.correlated.date, `max ${scenarios.correlated.tMax} degC`);
console.log(`existing electricity ${(elecKwh / 1e6).toFixed(2)} GWh/yr, gas ${(gasKwh / 1e6).toFixed(2)} GWh/yr -> gas price band ${gasPrice === PRICES.gasSmallGbpPerKwh ? 'Small' : 'Medium'}`);
console.log('band prices £/kWh:', bandPrice, '(calibrated average', PRICES.electricityAvgGbpPerKwh, ')');
