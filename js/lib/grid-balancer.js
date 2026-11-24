// js/lib/grid-balancer.js
//
// The model behind Grid Balancer on /games/. A day on a simplified grid runs
// in three minutes: demand follows a weekday shape, wind and sun come and go,
// and the player dispatches gas, pumped hydro and a fast peaker to keep the
// frequency near 50 Hz. A battery answers frequency on its own, as the fast
// response services do on the real system.
//
// Everything here is plain arithmetic with no DOM, so it can be tested on its
// own. js/grid-balancer.js draws it and wires up the controls.

export const NOMINAL_HZ = 50;

// One day in real seconds, and what one real second is worth in grid hours.
export const DAY_SECONDS = 180;
export const HOURS_PER_SECOND = 24 / DAY_SECONDS;

// Simulation step, in real seconds.
export const STEP = 0.05;

// System stiffness: a 1 GW imbalance held for long settles about 0.2 Hz off
// nominal. TAU is how quickly it gets there.
export const STIFFNESS_GW_PER_HZ = 5;
export const TAU = 1.2;

// Frequency bands, as deviations from 50 Hz.
export const BANDS = {
  tight: 0.05,
  good: 0.1,
  statutory: 0.2,
  protection: 0.5,
  blackout: 1.0
};

export const PLANT = {
  nuclear: 5.5,
  gasMax: 26,
  gasRamp: 0.45,          // GW per real second, up or down
  hydroMax: 2,            // GW, generating or pumping
  hydroTau: 0.8,          // s
  reservoirMax: 10,       // GWh
  reservoirStart: 7,
  pumpEfficiency: 0.75,
  peaker: 2.5,
  peakerTau: 0.7,
  batteryMax: 1,          // GW
  batteryFullAt: 0.2,     // Hz deviation for full output
  batteryEnergy: 1,       // GWh
  windCapacity: 20,
  solarPeak: 8
};

// Tonnes of CO2 per MWh.
export const CARBON = { gas: 0.37, peaker: 0.65 };

// Protection: past 0.5 Hz the system acts on its own for a while, and the
// third time it has to, the operator is judged to have lost control.
export const PROTECTION = { shedGw: 3, seconds: 10, penalty: 400, limit: 3 };

export const LEVELS = {
  calm: {
    label: 'Calm',
    windMean: 4.5, windSwing: 2, windNoise: 0.25,
    trips: 1, lulls: 0, cutouts: 0, clouds: 1
  },
  windy: {
    label: 'Windy',
    windMean: 10, windSwing: 4, windNoise: 0.4,
    trips: 1, lulls: 2, cutouts: 0, clouds: 2
  },
  storm: {
    label: 'Storm',
    windMean: 13.5, windSwing: 5, windNoise: 0.5,
    trips: 2, lulls: 1, cutouts: 1, clouds: 3
  }
};

// Weekday demand in GW at each hour 0..24, a winter shape with a morning ramp
// and the evening peak just after five.
const DEMAND_HOURLY = [
  27, 25.5, 24.5, 24, 24, 25, 27.5, 31, 33.5, 34, 33.5, 33, 33,
  32.5, 32, 32.5, 34.5, 37, 36.5, 35, 33.5, 31.5, 29.5, 28, 27
];

// Mulberry32: small, fast and good enough to make every visitor's day the same.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Catmull-Rom through the hourly points, so the curve has no corners.
export function demandForecast(hour) {
  const h = Math.min(24, Math.max(0, hour));
  const i = Math.min(23, Math.floor(h));
  const t = h - i;
  const p = k => DEMAND_HOURLY[Math.min(24, Math.max(0, k))];
  const p0 = p(i - 1), p1 = p(i), p2 = p(i + 1), p3 = p(i + 2);
  return 0.5 * ((2 * p1) + (-p0 + p2) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
    + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
}

// Clear-sky solar, sunrise at 06:00 and sunset at 19:00.
export function solarClearSky(hour) {
  const x = (hour - 6) / 13;
  if (x <= 0 || x >= 1) return 0;
  return PLANT.solarPeak * Math.pow(Math.sin(Math.PI * x), 1.5);
}

function bump(hour, start, length, ramp) {
  // 0 outside [start, start + length], 1 inside, with linear ramps of `ramp`
  // hours at each end.
  if (hour <= start || hour >= start + length) return 0;
  const up = (hour - start) / ramp;
  const down = (start + length - hour) / ramp;
  return Math.max(0, Math.min(1, up, down));
}

// The day's weather and incidents, fixed by the seed. Forecasts the player is
// shown come from here without the events or the noise.
export function planDay(levelKey, seed) {
  const level = LEVELS[levelKey];
  if (!level) throw new Error(`unknown level: ${levelKey}`);
  const r = rng(seed);
  const between = (lo, hi) => lo + (hi - lo) * r();

  const waves = [6, 3.2, 1.4].map((period, i) => ({
    period: period * between(0.85, 1.15),
    phase: between(0, Math.PI * 2),
    amp: level.windSwing * [0.6, 0.3, 0.15][i]
  }));

  const events = [];

  for (let i = 0; i < level.trips; i++) {
    events.push({
      kind: 'trip', start: between(3 + i * 9, 10 + i * 9), length: between(1.2, 2),
      gw: 1.2, announced: false,
      text: 'A nuclear unit has tripped: 1.2 GW lost without warning.'
    });
  }

  const kickoff = between(19.6, 21);
  events.push({
    kind: 'kettles', start: kickoff, length: 0.3, gw: 1.8, announced: true, warnAhead: 0.75,
    warn: 'Half-time in a big match is coming: expect kettles to add about 1.8 GW.',
    text: 'Half-time: kettles across the country add 1.8 GW of demand.'
  });

  for (let i = 0; i < level.lulls; i++) {
    events.push({
      kind: 'lull', start: between(1 + i * 11, 9 + i * 11), length: between(1.5, 2.5),
      fraction: 0.55, announced: false,
      text: 'The wind is dropping faster than forecast.'
    });
  }

  for (let i = 0; i < level.cutouts; i++) {
    events.push({
      kind: 'cutout', start: between(13, 17.5), length: between(0.8, 1.3),
      gw: 5, announced: false,
      text: 'Storm-force gusts: wind farms shut down to protect their turbines.'
    });
  }

  for (let i = 0; i < level.clouds; i++) {
    events.push({
      kind: 'cloud', start: between(9, 15), length: between(0.8, 1.6),
      fraction: 0.45, announced: false,
      text: 'A bank of cloud is cutting solar output.'
    });
  }

  events.sort((a, b) => a.start - b.start);
  return { level: levelKey, seed, waves, events, noiseSeed: Math.floor(r() * 2 ** 32) };
}

export function windForecast(plan, hour) {
  const level = LEVELS[plan.level];
  let w = level.windMean;
  for (const { period, phase, amp } of plan.waves) {
    w += amp * Math.sin((2 * Math.PI * hour) / period + phase);
  }
  return Math.min(PLANT.windCapacity, Math.max(0.5, w));
}

// What the events do at a given hour: scale factors and offsets.
export function eventEffects(plan, hour) {
  const fx = { windScale: 1, windDrop: 0, solarScale: 1, demandAdd: 0, nuclearLoss: 0 };
  for (const e of plan.events) {
    const ramp = e.kind === 'trip' ? 0.02 : e.kind === 'kettles' ? 0.06 : 0.25;
    // A trip is a step down and a slower return; the rest ramp both ways.
    const k = e.kind === 'trip'
      ? (hour >= e.start && hour < e.start + e.length
        ? Math.min(1, (e.start + e.length - hour) / 0.3)
        : 0)
      : bump(hour, e.start, e.length, ramp);
    if (!k) continue;
    if (e.kind === 'trip') fx.nuclearLoss += e.gw * k;
    if (e.kind === 'kettles') fx.demandAdd += e.gw * k;
    if (e.kind === 'lull') fx.windScale *= 1 - e.fraction * k;
    if (e.kind === 'cutout') fx.windDrop += e.gw * k;
    if (e.kind === 'cloud') fx.solarScale *= 1 - e.fraction * k;
  }
  return fx;
}

export function scoreRate(deviation) {
  const d = Math.abs(deviation);
  if (d <= BANDS.tight) return 20;
  if (d <= BANDS.good) return 15;
  if (d <= BANDS.statutory) return 8;
  if (d <= BANDS.protection) return 0;
  return -30;
}

export function createGame(levelKey, seed) {
  const plan = planDay(levelKey, seed);
  const noise = rng(plan.noiseSeed);
  const gauss = () => {
    // Box-Muller from the seeded stream.
    const u = Math.max(1e-9, noise());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * noise());
  };

  const start = baseState(plan);
  return {
    plan,
    gauss,
    ...start,
    controls: { gasTarget: start.gas, hydroTarget: 0, peaker: false, windAllowed: 1 }
  };
}

// Begin at midnight with the books balanced, so the first seconds are calm.
function baseState(plan) {
  const demand = demandForecast(0);
  const wind = windForecast(plan, 0);
  const gas = Math.min(PLANT.gasMax, Math.max(0, roundHalf(demand - PLANT.nuclear - wind)));
  return {
    t: 0,
    hour: 0,
    freq: NOMINAL_HZ,
    gas,
    hydro: 0,
    peakerOut: 0,
    battery: 0,
    batterySoc: 0.5,
    reservoir: PLANT.reservoirStart,
    demandNoise: 0,
    windNoise: 0,
    protection: { left: 0, kind: null, count: 0 },
    over: false,
    blackout: false,
    score: 0,
    carbonT: 0,
    curtailedGwh: 0,
    secondsInBand: 0,
    secondsTotal: 0,
    eventsFired: new Set(),
    log: [],
    last: null
  };
}

function roundHalf(x) {
  return Math.round(x * 2) / 2;
}

// Advance the game by one STEP. Returns the snapshot it ended on.
export function step(game) {
  if (game.over) return game.last;
  const dt = STEP;
  const level = LEVELS[game.plan.level];
  const c = game.controls;

  game.t += dt;
  game.hour = Math.min(24, game.t * HOURS_PER_SECOND);
  const hour = game.hour;

  // Announcements and incidents.
  for (const [i, e] of game.plan.events.entries()) {
    if (e.announced && !game.eventsFired.has(`warn${i}`) && hour >= e.start - e.warnAhead) {
      game.eventsFired.add(`warn${i}`);
      game.log.push({ hour, kind: 'warn', text: e.warn });
    }
    if (!game.eventsFired.has(i) && hour >= e.start) {
      game.eventsFired.add(i);
      game.log.push({ hour, kind: e.kind, text: e.text });
    }
  }
  const fx = eventEffects(game.plan, hour);

  // Slow random wander on demand and wind, on top of the forecasts.
  game.demandNoise += -game.demandNoise * 0.15 * dt + 0.18 * Math.sqrt(dt) * game.gauss();
  game.windNoise += -game.windNoise * 0.08 * dt + level.windNoise * Math.sqrt(dt) * game.gauss();

  let demand = demandForecast(hour) + game.demandNoise + fx.demandAdd;
  const nuclear = PLANT.nuclear - fx.nuclearLoss;
  const windAvailable = Math.max(0, Math.min(PLANT.windCapacity,
    (windForecast(game.plan, hour) + game.windNoise) * fx.windScale - fx.windDrop));
  const wind = windAvailable * c.windAllowed;
  const solar = solarClearSky(hour) * fx.solarScale;

  // Gas ramps toward its target.
  const gasGap = c.gasTarget - game.gas;
  game.gas += Math.sign(gasGap) * Math.min(Math.abs(gasGap), PLANT.gasRamp * dt);

  // Pumped hydro follows its setting quickly, as long as the reservoir allows.
  let hydroTarget = c.hydroTarget;
  if (hydroTarget > 0 && game.reservoir <= 0) hydroTarget = 0;
  if (hydroTarget < 0 && game.reservoir >= PLANT.reservoirMax) hydroTarget = 0;
  game.hydro += (hydroTarget - game.hydro) * Math.min(1, dt / PLANT.hydroTau);
  const hydroGwh = game.hydro * dt * HOURS_PER_SECOND;
  game.reservoir -= game.hydro > 0 ? hydroGwh : hydroGwh * PLANT.pumpEfficiency;
  game.reservoir = Math.min(PLANT.reservoirMax, Math.max(0, game.reservoir));

  game.peakerOut += ((c.peaker ? PLANT.peaker : 0) - game.peakerOut) * Math.min(1, dt / PLANT.peakerTau);

  // The battery answers frequency in proportion, within its energy.
  const deviation = game.freq - NOMINAL_HZ;
  let battery = -deviation / PLANT.batteryFullAt * PLANT.batteryMax;
  battery = Math.max(-PLANT.batteryMax, Math.min(PLANT.batteryMax, battery));
  // Near nominal it drifts back toward half charge, ready for the next event.
  if (Math.abs(deviation) < BANDS.tight) battery += (game.batterySoc - 0.5) * 0.3;
  if (battery > 0 && game.batterySoc <= 0) battery = 0;
  if (battery < 0 && game.batterySoc >= 1) battery = 0;
  game.battery = battery;
  game.batterySoc -= battery * dt * HOURS_PER_SECOND / PLANT.batteryEnergy;
  game.batterySoc = Math.min(1, Math.max(0, game.batterySoc));

  // Protection, once triggered, holds for a while. Shedding demand lifts
  // frequency; tripping generation lowers it.
  if (game.protection.left > 0) game.protection.left -= dt;
  if (game.protection.kind === 'low' && game.protection.left > 0) demand -= PROTECTION.shedGw;
  const tripped = game.protection.kind === 'high' && game.protection.left > 0 ? PROTECTION.shedGw : 0;

  const supply = nuclear + wind + solar + game.gas + game.hydro + game.peakerOut + battery - tripped;
  const imbalance = supply - demand;

  const m = STIFFNESS_GW_PER_HZ * TAU;
  game.freq += dt * (imbalance - STIFFNESS_GW_PER_HZ * (game.freq - NOMINAL_HZ)) / m;

  const dev = game.freq - NOMINAL_HZ;
  if (game.protection.left <= 0 && Math.abs(dev) > BANDS.protection) {
    game.protection.count += 1;
    game.protection.left = PROTECTION.seconds;
    game.protection.kind = dev < 0 ? 'low' : 'high';
    game.score -= PROTECTION.penalty;
    game.log.push({
      hour,
      kind: 'protection',
      text: dev < 0
        ? 'Frequency below 49.5 Hz: automatic demand disconnection has cut 3 GW of customers.'
        : 'Frequency above 50.5 Hz: protection has tripped 3 GW of generation.'
    });
    if (game.protection.count >= PROTECTION.limit) {
      endGame(game, true, 'Protection had to act three times. The system operator has lost control: blackout.');
    }
  }
  if (Math.abs(dev) >= BANDS.blackout) {
    endGame(game, true, `Frequency reached ${game.freq.toFixed(2)} Hz and the grid collapsed: blackout.`);
  }

  // Scoring and the day's tallies.
  game.score += scoreRate(dev) * dt;
  game.secondsTotal += dt;
  if (Math.abs(dev) <= BANDS.statutory) game.secondsInBand += dt;
  const mwh = gw => gw * dt * HOURS_PER_SECOND * 1000;
  game.carbonT += mwh(game.gas) * CARBON.gas + mwh(game.peakerOut) * CARBON.peaker;
  game.curtailedGwh += (windAvailable - wind) * dt * HOURS_PER_SECOND;

  if (!game.over && game.hour >= 24) endGame(game, false, 'Midnight: the day is done.');

  game.last = {
    hour, freq: game.freq, demand, supply, imbalance,
    nuclear, wind, windAvailable, solar,
    gas: game.gas, hydro: game.hydro, peaker: game.peakerOut, battery,
    reservoir: game.reservoir, batterySoc: game.batterySoc
  };
  return game.last;
}

function endGame(game, blackout, text) {
  game.over = true;
  game.blackout = blackout;
  game.log.push({ hour: game.hour, kind: blackout ? 'blackout' : 'end', text });
}

// The score a finished day keeps: stability points less a carbon charge of one
// point per 200 tonnes. A blackout keeps half.
export function finalScore(game) {
  const raw = game.score - game.carbonT / 200;
  return Math.max(0, Math.round(game.blackout ? raw / 2 : raw));
}

export function summary(game) {
  return {
    score: finalScore(game),
    inBand: game.secondsTotal ? game.secondsInBand / game.secondsTotal : 0,
    carbonKt: game.carbonT / 1000,
    curtailedGwh: game.curtailedGwh,
    protections: game.protection.count,
    blackout: game.blackout,
    hour: game.hour
  };
}

export function clock(hour) {
  const minutes = Math.min(24 * 60 - 1, Math.floor(hour * 60));
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}
