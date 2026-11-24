// Grid Balancer on /games/: the model in js/lib/grid-balancer.js, and the
// page wiring that makes it reachable the way the Tools page is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BANDS,
  DAY_SECONDS,
  LEVELS,
  NOMINAL_HZ,
  PLANT,
  PROTECTION,
  STEP,
  clock,
  createGame,
  demandForecast,
  eventEffects,
  finalScore,
  hashSeed,
  planDay,
  scoreRate,
  solarClearSky,
  step,
  summary,
  windForecast
} from '../js/lib/grid-balancer.js';

const SEED = hashSeed('2026-11-24|calm');

// A competent player: steer gas by the forecast an hour ahead and trim with
// hydro and the peaker on what is happening now.
function playWell(game) {
  while (!game.over) {
    const s = step(game);
    const ahead = Math.min(24, game.hour + 1);
    const fx = eventEffects(game.plan, game.hour);
    const now = s.demand - s.nuclear - s.windAvailable - s.solar;
    const net = now
      + (demandForecast(ahead) - demandForecast(game.hour))
      - (windForecast(game.plan, ahead) - windForecast(game.plan, game.hour))
      - (solarClearSky(ahead) - solarClearSky(game.hour)) * fx.solarScale;
    game.controls.gasTarget = Math.max(0, Math.min(PLANT.gasMax, Math.round(net * 2) / 2));
    const gap = s.demand - (s.supply - s.hydro - s.battery);
    game.controls.hydroTarget = Math.max(-PLANT.hydroMax, Math.min(PLANT.hydroMax, Math.round(gap * 4) / 4));
    game.controls.peaker = gap > 2.2;
  }
  return game;
}

test('the same date and level always give the same day', () => {
  assert.deepEqual(planDay('windy', 123), planDay('windy', 123));
  assert.notDeepEqual(planDay('windy', 123).events, planDay('windy', 124).events);
  const a = createGame('storm', 9);
  const b = createGame('storm', 9);
  for (let i = 0; i < 400; i++) { step(a); step(b); }
  assert.equal(a.freq, b.freq);
});

test('demand has a night trough and an evening peak, and the sun sets', () => {
  assert.ok(demandForecast(4) < demandForecast(12));
  assert.ok(demandForecast(17) > demandForecast(12));
  assert.ok(Math.abs(demandForecast(0) - demandForecast(24)) < 0.01);
  assert.equal(solarClearSky(3), 0);
  assert.equal(solarClearSky(21), 0);
  assert.ok(solarClearSky(12.5) > PLANT.solarPeak * 0.95);
  for (let h = 0; h <= 24; h += 0.5) {
    const w = windForecast(planDay('storm', 5), h);
    assert.ok(w >= 0.5 && w <= PLANT.windCapacity);
  }
});

test('every level plans a half-time surge that is announced in advance', () => {
  for (const level of Object.keys(LEVELS)) {
    const kettles = planDay(level, SEED).events.filter(e => e.kind === 'kettles');
    assert.equal(kettles.length, 1);
    assert.ok(kettles[0].announced && kettles[0].warnAhead > 0);
  }
});

test('the day starts balanced at 50 Hz', () => {
  const game = createGame('calm', SEED);
  for (let i = 0; i < 40; i++) step(game);
  assert.ok(Math.abs(game.freq - NOMINAL_HZ) < BANDS.good);
});

test('a shortfall pulls frequency down and the battery pushes back', () => {
  const game = createGame('calm', SEED);
  game.gas = Math.max(0, game.gas - 2);
  game.controls.gasTarget = game.gas;
  let s;
  for (let i = 0; i < 20; i++) s = step(game);
  assert.ok(game.freq < NOMINAL_HZ);
  assert.ok(s.battery > 0);
});

test('gas ramps at its limit and no faster', () => {
  const game = createGame('calm', SEED);
  const before = game.gas;
  game.controls.gasTarget = PLANT.gasMax;
  step(game);
  assert.ok(Math.abs(game.gas - before - PLANT.gasRamp * STEP) < 1e-9);
});

test('the reservoir drains when generating and fills when pumping', () => {
  const game = createGame('calm', SEED);
  game.controls.hydroTarget = PLANT.hydroMax;
  for (let i = 0; i < 100; i++) step(game);
  assert.ok(game.reservoir < PLANT.reservoirStart);
  const low = game.reservoir;
  game.controls.hydroTarget = -PLANT.hydroMax;
  for (let i = 0; i < 200; i++) step(game);
  assert.ok(game.reservoir > low);
});

test('scoring rewards staying close to 50 Hz and punishes leaving the safe band', () => {
  assert.ok(scoreRate(0) > scoreRate(0.08));
  assert.ok(scoreRate(0.08) > scoreRate(0.15));
  assert.equal(scoreRate(0.3), 0);
  assert.ok(scoreRate(-0.6) < 0);
});

test('a player who does nothing blacks out well before midnight', () => {
  for (const level of Object.keys(LEVELS)) {
    const game = createGame(level, SEED);
    while (!game.over) step(game);
    assert.equal(game.blackout, true, level);
    assert.ok(game.hour < 12, `${level} lasted until ${clock(game.hour)}`);
    assert.ok(game.protection.count <= PROTECTION.limit);
    assert.equal(finalScore(game) >= 0, true);
  }
});

test('a careful player can keep every level running until midnight', () => {
  for (const level of Object.keys(LEVELS)) {
    const game = playWell(createGame(level, SEED));
    const s = summary(game);
    assert.equal(s.blackout, false, level);
    assert.ok(s.inBand > 0.8, `${level}: ${s.inBand}`);
    assert.ok(Math.abs(game.t - DAY_SECONDS) < 0.1);
  }
});

test('clock formats grid hours', () => {
  assert.equal(clock(0), '00:00');
  assert.equal(clock(17.5), '17:30');
  assert.equal(clock(24), '23:59');
});

test('the games page carries the game, and the updates page links to it', () => {
  const games = readFileSync(new URL('../games/index.html', import.meta.url), 'utf8');
  assert.match(games, /<body class="page-games">/);
  assert.match(games, /id="grid-balancer"/);
  assert.match(games, /<link rel="canonical" href="https:\/\/mintorian\.com\/games\/" \/>/);
  assert.match(games, /src="\/js\/grid-balancer\.js\?v=/);
  const updates = readFileSync(new URL('../updates/index.html', import.meta.url), 'utf8');
  assert.match(updates, /<a href="\/games\/">/);
  const header = readFileSync(new URL('../js/header.js', import.meta.url), 'utf8');
  assert.match(header, /page-games/);
});
