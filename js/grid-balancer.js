// js/grid-balancer.js
//
// Grid Balancer on /games/: the drawing and the controls. The model, the day's
// weather and the scoring live in lib/grid-balancer.js and are tested there.

import {
  BANDS,
  LEVELS,
  NOMINAL_HZ,
  PLANT,
  STEP,
  clock,
  createGame,
  demandForecast,
  hashSeed,
  planDay,
  solarClearSky,
  step,
  summary,
  windForecast
} from './lib/grid-balancer.js';

const root = document.getElementById('grid-balancer');
if (root) init(root);

function init(root) {
  const $ = sel => root.querySelector(sel);

  const el = {
    levels: root.querySelectorAll('input[name="gb-level"]'),
    start: $('#gb-start'),
    pause: $('#gb-pause'),
    clock: $('#gb-clock'),
    freq: $('#gb-freq'),
    state: $('#gb-state'),
    score: $('#gb-score'),
    marker: $('#gb-marker'),
    trace: $('#gb-trace'),
    chart: $('#gb-chart'),
    demand: $('#gb-demand'),
    supply: $('#gb-supply'),
    gap: $('#gb-gap'),
    gas: $('#gb-gas'),
    gasOut: $('#gb-gas-out'),
    hydro: $('#gb-hydro'),
    hydroOut: $('#gb-hydro-out'),
    reservoir: $('#gb-reservoir'),
    peaker: $('#gb-peaker'),
    peakerOut: $('#gb-peaker-out'),
    wind: $('#gb-wind'),
    windOut: $('#gb-wind-out'),
    battery: $('#gb-battery'),
    batteryOut: $('#gb-battery-out'),
    log: $('#gb-log'),
    announce: $('#gb-announce'),
    results: $('#gb-results'),
    seedNote: $('#gb-seed')
  };

  const controls = [el.gas, el.hydro, el.peaker, el.wind, el.pause];

  let game = null;
  let running = false;
  let paused = false;
  let lastFrame = 0;
  let carry = 0;
  let history = [];
  let trace = [];
  let sinceSample = 0;
  let logShown = 0;
  let lastChartDraw = 0;

  const today = localDate();
  const levelKey = () => [...el.levels].find(r => r.checked)?.value || 'calm';
  const seedFor = key => hashSeed(`${today}|${key}`);

  el.seedNote.textContent = `Today's day (${formatDate(today)}) is the same for everyone who plays it.`;

  setControlsEnabled(false);
  syncControlLabels();
  drawChart();
  drawTrace();

  el.levels.forEach(r => r.addEventListener('change', () => {
    if (!running) drawChart();
  }));

  el.start.addEventListener('click', startGame);
  el.pause.addEventListener('click', () => setPaused(!paused));

  el.gas.addEventListener('input', () => {
    if (game) game.controls.gasTarget = Number(el.gas.value);
    syncControlLabels();
  });
  el.hydro.addEventListener('input', () => {
    if (game) game.controls.hydroTarget = Number(el.hydro.value);
    syncControlLabels();
  });
  el.wind.addEventListener('input', () => {
    if (game) game.controls.windAllowed = Number(el.wind.value) / 100;
    syncControlLabels();
  });
  el.peaker.addEventListener('click', () => {
    if (!game) return;
    game.controls.peaker = !game.controls.peaker;
    el.peaker.setAttribute('aria-pressed', String(game.controls.peaker));
    syncControlLabels();
  });

  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && running && !paused) setPaused(true);
  });

  const resize = new ResizeObserver(() => {
    drawChart();
    drawTrace();
  });
  resize.observe(el.chart);
  resize.observe(el.trace);

  // The sticky readout sits just under the site header, whose height changes
  // with the viewport.
  const header = document.getElementById('header');
  if (header) {
    const place = () => root.style.setProperty('--gb-top', `${Math.round(header.getBoundingClientRect().height)}px`);
    place();
    new ResizeObserver(place).observe(header);
  }

  function startGame() {
    const key = levelKey();
    game = createGame(key, seedFor(key));
    history = [];
    trace = [];
    sinceSample = 0;
    carry = 0;
    logShown = 0;
    el.log.replaceChildren();
    el.results.hidden = true;
    el.results.replaceChildren();

    el.gas.value = String(game.controls.gasTarget);
    el.hydro.value = '0';
    el.wind.value = '100';
    el.peaker.setAttribute('aria-pressed', 'false');
    el.levels.forEach(r => { r.disabled = true; });
    el.start.textContent = 'Restart the day';
    setControlsEnabled(true);
    setPaused(false);
    running = true;

    record(step(game));
    syncControlLabels();
    say(`${LEVELS[key].label} day started at midnight. Keep the frequency near 50 hertz.`);
    lastFrame = performance.now();
    requestAnimationFrame(frame);
  }

  function setPaused(value) {
    paused = value;
    el.pause.textContent = paused ? 'Resume' : 'Pause';
    el.pause.setAttribute('aria-pressed', String(paused));
    root.classList.toggle('is-paused', paused);
    if (!paused && running) {
      lastFrame = performance.now();
      requestAnimationFrame(frame);
    }
  }

  function frame(now) {
    if (!running || paused) return;
    const elapsed = Math.min(0.25, (now - lastFrame) / 1000);
    lastFrame = now;
    carry += elapsed;
    let snap = null;
    while (carry >= STEP && !game.over) {
      carry -= STEP;
      snap = step(game);
      trace.push(game.freq);
      sinceSample += STEP;
      if (sinceSample >= 0.25) {
        sinceSample = 0;
        record(snap);
      }
    }
    if (trace.length > 300) trace.splice(0, trace.length - 300);
    if (snap) render(snap, now);
    flushLog();
    if (game.over) return finish();
    requestAnimationFrame(frame);
  }

  function record(snap) {
    if (!snap) return;
    history.push({
      hour: snap.hour,
      demand: snap.demand,
      nuclear: snap.nuclear,
      wind: snap.wind,
      solar: snap.solar,
      gas: snap.gas,
      peaker: snap.peaker,
      storage: Math.max(0, snap.hydro + snap.battery)
    });
  }

  function render(s, now) {
    const dev = s.freq - NOMINAL_HZ;
    el.clock.textContent = clock(s.hour);
    el.freq.textContent = `${s.freq.toFixed(2)} Hz`;
    const state = stateFor(dev);
    el.state.textContent = state.text;
    root.dataset.state = state.key;
    el.score.textContent = Math.round(game.score).toLocaleString('en-GB');

    const pos = Math.min(1, Math.max(0, (s.freq - 49) / 2));
    el.marker.style.left = `${pos * 100}%`;

    el.demand.textContent = gw(s.demand);
    el.supply.textContent = gw(s.supply);
    const gap = s.supply - s.demand;
    el.gap.textContent = Math.abs(gap) < 0.05 ? '0.0 GW' : `${gap > 0 ? '+' : '−'}${Math.abs(gap).toFixed(1)} GW`;
    el.gap.dataset.sign = Math.abs(gap) < 0.3 ? 'even' : gap > 0 ? 'over' : 'under';

    el.gasOut.textContent = `Target ${gw(game.controls.gasTarget)} · running ${gw(s.gas)}`;
    el.hydroOut.textContent = hydroText(s.hydro);
    setMeter(el.reservoir, s.reservoir / PLANT.reservoirMax, `Reservoir ${s.reservoir.toFixed(1)} of ${PLANT.reservoirMax} GWh`);
    el.peakerOut.textContent = s.peaker > 0.05 ? `Running ${gw(s.peaker)}` : 'Off';
    el.windOut.textContent = `${el.wind.value}% allowed · ${gw(s.wind)} of ${gw(s.windAvailable)}`;
    el.batteryOut.textContent = s.battery > 0.05 ? `Discharging ${gw(s.battery)}`
      : s.battery < -0.05 ? `Charging ${gw(-s.battery)}` : 'Standing by';
    setMeter(el.battery, s.batterySoc, `Battery ${Math.round(s.batterySoc * 100)}% charged`);

    drawTrace();
    if (now - lastChartDraw > 120) {
      lastChartDraw = now;
      drawChart();
    }
  }

  function flushLog() {
    while (game && logShown < game.log.length) {
      const entry = game.log[logShown++];
      const li = document.createElement('li');
      li.className = `gb-log__item gb-log__item--${entry.kind}`;
      const time = document.createElement('span');
      time.className = 'gb-log__time';
      time.textContent = clock(entry.hour);
      const text = document.createElement('span');
      text.textContent = entry.text;
      li.append(time, text);
      el.log.prepend(li);
      while (el.log.children.length > 6) el.log.lastElementChild.remove();
      say(entry.text);
    }
  }

  function finish() {
    running = false;
    setControlsEnabled(false);
    el.levels.forEach(r => { r.disabled = false; });
    el.start.textContent = 'Play again';
    drawChart();

    const s = summary(game);
    const key = game.plan.level;
    const bestKey = `grid-balancer-best-${key}`;
    let best = 0;
    try { best = Number(localStorage.getItem(bestKey)) || 0; } catch { /* private mode */ }
    const isBest = s.score > best;
    if (isBest) {
      try { localStorage.setItem(bestKey, String(s.score)); } catch { /* private mode */ }
    }

    const title = document.createElement('h3');
    title.className = 'gb-results__title';
    title.textContent = s.blackout ? `Blackout at ${clock(s.hour)}` : 'You kept the lights on';

    const list = document.createElement('dl');
    list.className = 'gb-results__stats';
    const n = v => Math.round(v).toLocaleString('en-GB');
    const rows = [
      ['Score', s.score.toLocaleString('en-GB') + (isBest ? ' (your best)' : best ? ` (best ${best.toLocaleString('en-GB')})` : '')],
      ['How it adds up', `${n(game.score)} for steadiness − ${n(game.carbonT / 200)} for carbon${s.blackout ? ', halved for the blackout' : ''}`],
      ['Time within 49.8–50.2 Hz', `${Math.round(s.inBand * 100)}%`],
      ['Carbon from gas', `${Math.round(s.carbonKt).toLocaleString('en-GB')} kt CO₂`],
      ['Wind curtailed', `${s.curtailedGwh.toFixed(1)} GWh`],
      ['Times protection acted', String(s.protections)]
    ];
    for (const [k, v] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      list.append(dt, dd);
    }

    const note = document.createElement('p');
    note.className = 'gb-results__note';
    note.textContent = verdict(s);

    const share = document.createElement('button');
    share.type = 'button';
    share.className = 'gb-button gb-button--ghost';
    share.textContent = 'Copy my result';
    share.addEventListener('click', async () => {
      const text = `Grid Balancer · ${LEVELS[key].label} day · ${formatDate(today)}\n`
        + `${s.blackout ? `Blackout at ${clock(s.hour)}` : 'Lights kept on'} · ${s.score.toLocaleString('en-GB')} points · `
        + `${Math.round(s.inBand * 100)}% in band\nhttps://mintorian.com/games/`;
      try {
        await navigator.clipboard.writeText(text);
        share.textContent = 'Copied';
      } catch {
        share.textContent = 'Copy failed';
      }
    });

    el.results.append(title, list, note, share);
    el.results.hidden = false;
    say(`${title.textContent}. Score ${s.score}.`);
  }

  function verdict(s) {
    if (s.blackout) return 'Gas is slow, so start it ramping before demand climbs: the dashed lines on the chart show what is coming.';
    if (s.inBand > 0.97 && s.protections === 0) return 'A control-room shift to be proud of.';
    if (s.inBand > 0.85) return 'Solid. Lean on pumped hydro for the quick swings and keep gas for the slow ones.';
    return 'The lights stayed on, just. Watch the gap between the dashed lines to plan your gas.';
  }

  function onKey(event) {
    if (!running || event.altKey || event.ctrlKey || event.metaKey) return;
    const tag = event.target?.tagName;
    if (tag === 'TEXTAREA' || (tag === 'INPUT' && event.target.type !== 'range' && event.target.type !== 'radio')) return;
    if (event.target?.isContentEditable) return;
    const k = event.key.toLowerCase();
    const nudge = (input, by) => {
      input.value = String(Number(input.value) + by);
      input.dispatchEvent(new Event('input'));
    };
    if (k === 'p') {
      setPaused(!paused);
    } else if (paused) {
      return;
    } else if (k === 'q') {
      nudge(el.gas, 1);
    } else if (k === 'a') {
      nudge(el.gas, -1);
    } else if (k === 'w') {
      nudge(el.hydro, 0.5);
    } else if (k === 's') {
      nudge(el.hydro, -0.5);
    } else if (k === 'e') {
      el.peaker.click();
    } else {
      return;
    }
    event.preventDefault();
  }

  function setControlsEnabled(on) {
    controls.forEach(c => { c.disabled = !on; });
    root.classList.toggle('is-running', on);
  }

  function syncControlLabels() {
    if (!game) {
      el.gasOut.textContent = `Target ${gw(Number(el.gas.value))}`;
      el.hydroOut.textContent = hydroText(Number(el.hydro.value));
      el.windOut.textContent = `${el.wind.value}% allowed`;
      el.peakerOut.textContent = 'Off';
      el.batteryOut.textContent = 'Standing by';
      setMeter(el.reservoir, PLANT.reservoirStart / PLANT.reservoirMax, `Reservoir ${PLANT.reservoirStart} of ${PLANT.reservoirMax} GWh`);
      setMeter(el.battery, 0.5, 'Battery 50% charged');
      return;
    }
    el.gasOut.textContent = `Target ${gw(game.controls.gasTarget)} · running ${gw(game.gas)}`;
    el.peakerOut.textContent = game.controls.peaker ? 'Starting' : 'Off';
  }

  function say(text) {
    el.announce.textContent = '';
    // A fresh node each time, so screen readers announce repeats.
    requestAnimationFrame(() => { el.announce.textContent = text; });
  }

  // ---- Drawing -------------------------------------------------------------

  function colours() {
    const css = getComputedStyle(root);
    const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    return {
      ink: v('--ink', '#0a1a3b'),
      muted: v('--ink-muted', '#5b6b7b'),
      rule: v('--rule-edge', 'rgba(10,33,82,.07)'),
      nuclear: v('--fuel-nuclear', '#4a3aa7'),
      wind: v('--fuel-wind', '#2a78d6'),
      solar: v('--fuel-solar', '#eda100'),
      gas: v('--fuel-gas', '#e34948'),
      peaker: v('--fuel-other', '#e87ba4'),
      storage: v('--fuel-imports', '#1baf7a'),
      good: v('--status-good', '#0ca30c'),
      warning: v('--status-warning', '#fab219'),
      critical: v('--status-critical', '#d03b3b')
    };
  }

  function fitCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function drawChart() {
    const { ctx, w, h } = fitCanvas(el.chart);
    const c = colours();
    const pad = { l: 38, r: 10, t: 10, b: 24 };
    const yMax = 45;
    const x = hour => pad.l + (hour / 24) * (w - pad.l - pad.r);
    const y = v => pad.t + (1 - v / yMax) * (h - pad.t - pad.b);

    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (let v = 0; v <= 40; v += 10) {
      ctx.strokeStyle = c.rule;
      ctx.beginPath();
      ctx.moveTo(pad.l, y(v) + 0.5);
      ctx.lineTo(w - pad.r, y(v) + 0.5);
      ctx.stroke();
      ctx.fillStyle = c.muted;
      ctx.textAlign = 'right';
      ctx.fillText(`${v}`, pad.l - 6, y(v));
    }
    ctx.save();
    ctx.translate(10, y(yMax / 2));
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('GW', 0, 0);
    ctx.restore();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let hr = 0; hr <= 24; hr += 3) {
      ctx.fillStyle = c.muted;
      ctx.fillText(hr === 24 ? '24:00' : clock(hr), x(hr), h - pad.b + 6);
    }

    // Stacked supply so far.
    const layers = ['nuclear', 'wind', 'solar', 'gas', 'peaker', 'storage'];
    if (history.length > 1) {
      const base = history.map(() => 0);
      for (const layer of layers) {
        const top = history.map((p, i) => base[i] + p[layer]);
        ctx.beginPath();
        history.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, x(p.hour), y(top[i])));
        for (let i = history.length - 1; i >= 0; i--) ctx.lineTo(x(history[i].hour), y(base[i]));
        ctx.closePath();
        ctx.fillStyle = c[layer];
        ctx.globalAlpha = 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
        top.forEach((v, i) => { base[i] = v; });
      }
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 2;
      ctx.beginPath();
      history.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, x(p.hour), y(p.demand)));
      ctx.stroke();
    }

    // Forecasts for the rest of the day.
    const plan = game ? game.plan : planDay(levelKey(), seedFor(levelKey()));
    const from = game ? game.hour : 0;
    if (from < 24) {
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5;
      const line = (fn, colour) => {
        ctx.strokeStyle = colour;
        ctx.beginPath();
        for (let hr = from, i = 0; hr <= 24.0001; hr += 0.1, i++) {
          (i ? ctx.lineTo : ctx.moveTo).call(ctx, x(Math.min(24, hr)), y(fn(Math.min(24, hr))));
        }
        ctx.stroke();
      };
      line(demandForecast, c.ink);
      line(hr => PLANT.nuclear + windForecast(plan, hr) + solarClearSky(hr), c.wind);
      ctx.setLineDash([]);
    }

    if (game) {
      ctx.strokeStyle = c.muted;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x(game.hour) + 0.5, pad.t);
      ctx.lineTo(x(game.hour) + 0.5, h - pad.b);
      ctx.stroke();
    }
  }

  function drawTrace() {
    const { ctx, w, h } = fitCanvas(el.trace);
    const c = colours();
    const lo = 49.4, hi = 50.6;
    const y = f => (1 - (Math.min(hi, Math.max(lo, f)) - lo) / (hi - lo)) * h;

    ctx.fillStyle = c.good;
    ctx.globalAlpha = 0.1;
    ctx.fillRect(0, y(NOMINAL_HZ + BANDS.statutory), w, y(NOMINAL_HZ - BANDS.statutory) - y(NOMINAL_HZ + BANDS.statutory));
    ctx.globalAlpha = 1;

    ctx.strokeStyle = c.rule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y(NOMINAL_HZ)) + 0.5);
    ctx.lineTo(w, Math.round(y(NOMINAL_HZ)) + 0.5);
    ctx.stroke();

    if (trace.length < 2) return;
    const n = 300;
    const offset = n - trace.length;
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    trace.forEach((f, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, ((offset + i) / (n - 1)) * w, y(f)));
    ctx.stroke();
  }
}

// ---- Helpers ---------------------------------------------------------------

function stateFor(dev) {
  const d = Math.abs(dev);
  if (d <= BANDS.good) return { key: 'steady', text: 'Steady' };
  if (d <= BANDS.statutory) return { key: 'drifting', text: dev < 0 ? 'Drifting low' : 'Drifting high' };
  if (d <= BANDS.protection) return { key: 'danger', text: dev < 0 ? 'Too little power' : 'Too much power' };
  return { key: 'critical', text: dev < 0 ? 'Shedding demand' : 'Tripping generation' };
}

function gw(v) {
  return `${Math.abs(v) < 0.05 ? '0.0' : v.toFixed(1)} GW`;
}

function hydroText(v) {
  if (v > 0.05) return `Generating ${gw(v)}`;
  if (v < -0.05) return `Pumping ${gw(-v)}`;
  return 'Idle';
}

function setMeter(meter, fraction, label) {
  const f = Math.min(1, Math.max(0, fraction));
  meter.style.setProperty('--fill', `${f * 100}%`);
  meter.setAttribute('aria-valuenow', String(Math.round(f * 100)));
  meter.setAttribute('aria-valuetext', label);
  meter.title = label;
}

function localDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
