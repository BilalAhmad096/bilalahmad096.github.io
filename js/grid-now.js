// js/grid-now.js
//
// "GB Grid, Right Now" - the live band under the About section.
//
// Two public feeds, called straight from the browser because both send
// Access-Control-Allow-Origin: *, so this stays a static page with no key and
// no Worker in the path:
//
//   api.carbonintensity.org.uk  carbon intensity now, the past 24 hours, and
//                               the national generation mix as percentages.
//                               Its mix includes embedded solar and small wind,
//                               which is why the shares are the headline here.
//   data.elexon.co.uk           half-hourly metered output in MW. Elexon meters
//                               transmission only, so its totals exclude that
//                               embedded generation - the two are shown in
//                               separate blocks and never added together.
//
// One file from this origin joins them: data/grid-records.json, the lowest and
// highest settled half hour this site has recorded. A static page cannot keep
// that record itself, so a scheduled job folds it and commits the file, which
// is why it is the site's record rather than each browser's.
//
// Every pure function here is exported and covered by tests/grid-now.test.js;
// the DOM half runs only in a browser.

const API_INTENSITY = 'https://api.carbonintensity.org.uk/intensity';
const API_MIX = 'https://api.carbonintensity.org.uk/generation';
const API_ELEXON = 'https://data.elexon.co.uk/bmrs/api/v1/generation/outturn/summary?format=json';
const RECORDS_FILE = '/data/grid-records.json';

const REFRESH_MS = 5 * 60 * 1000;   // the feeds move on the half hour; this only catches it
const REQUEST_TIMEOUT_MS = 8000;

/** The floor between reads, so flicking between tabs cannot become a poll. */
export const REFRESH_FLOOR_MS = 60 * 1000;

/**
 * The mix bar's fixed segment order, low-carbon first. Fixed rather than sorted
 * by size: these seven colours were validated pair by pair against this order,
 * and against every order left when a fuel reads zero, so re-sorting segments by
 * share would put untested colour pairs beside each other.
 */
export const FUEL_ORDER = ['wind', 'solar', 'nuclear', 'biomass', 'gas', 'imports', 'other'];

export const FUEL_LABELS = {
  wind: 'Wind',
  solar: 'Solar',
  nuclear: 'Nuclear',
  biomass: 'Biomass',
  gas: 'Gas',
  imports: 'Imports',
  other: 'Other',
  hydro: 'Hydro',
  coal: 'Coal'
};

// Hydro and coal fold into "Other" so the bar stays inside the seven colours
// that validate. The details table under it still lists all nine feed fuels by
// name, so nothing is hidden - coal at 4% would appear there in its own row.
const FOLDED_INTO_OTHER = ['hydro', 'coal', 'other'];

const ZERO_CARBON = ['wind', 'solar', 'hydro', 'nuclear'];

const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/London'
});

const dayFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  timeZone: 'Europe/London'
});

const longDayFormatter = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/London'
});

/**
 * The feed's five indices onto the four reserved status roles. The exact index
 * word is always printed beside the dot, so "very low" and "low" sharing a
 * colour costs no information.
 */
export function statusFor(index) {
  switch (String(index || '').toLowerCase()) {
    case 'very low':
    case 'low': return 'good';
    case 'moderate': return 'warning';
    case 'high': return 'serious';
    case 'very high': return 'critical';
    default: return 'unknown';
  }
}

/**
 * The current half hour. Prefers the settled reading and falls back to the
 * forecast, recording which it used - the newest period often carries only a
 * forecast, and a forecast printed as fact is the one error worth avoiding here.
 */
export function readIntensity(payload) {
  const period = payload?.data?.[0] ?? payload?.data;
  if (!period?.intensity) return null;

  const { actual, forecast, index } = period.intensity;
  const measured = Number.isFinite(actual);
  const value = measured ? actual : forecast;
  if (!Number.isFinite(value)) return null;

  return { value, index: index || null, measured, from: period.from, to: period.to };
}

/**
 * The past 24 hours, settled readings only. A forecast tail spliced onto the end
 * of a measured line would draw a trend nobody observed.
 */
export function readHistory(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows
    .filter(row => Number.isFinite(row?.intensity?.actual))
    .map(row => ({ at: row.from, value: row.intensity.actual }));
}

/**
 * The stored record, rejected unless both halves are complete. A record printed
 * as the site's own claim is worth more scepticism than a feed reading: half a
 * pair, or a value that is not a number, means the block does not draw.
 */
export function readRecords(payload) {
  const readingOf = candidate => (
    Number.isFinite(candidate?.value) && typeof candidate?.at === 'string'
      ? { value: candidate.value, at: candidate.at, index: candidate.index || null }
      : null);

  const lowest = readingOf(payload?.lowest);
  const highest = readingOf(payload?.highest);
  if (!lowest || !highest || typeof payload?.since !== 'string') return null;

  return { since: payload.since, through: payload.through || null, lowest, highest };
}

/**
 * Feed mix -> the seven drawn segments, plus the untouched nine for the table.
 * Segments at zero leave the bar: an invisible segment between two 2px gaps
 * prints as a 4px smear that reads as a colour nobody can name.
 */
export function foldMix(generationmix) {
  const rows = Array.isArray(generationmix) ? generationmix : [];
  if (!rows.length) return null;

  const byFuel = new Map();
  rows.forEach(row => {
    const fuel = String(row?.fuel || '').toLowerCase();
    const perc = Number(row?.perc);
    if (fuel && Number.isFinite(perc)) byFuel.set(fuel, perc);
  });
  if (!byFuel.size) return null;

  const shareOf = fuel => byFuel.get(fuel) ?? 0;
  const folded = FUEL_ORDER.map(key => ({
    key,
    label: FUEL_LABELS[key],
    percent: key === 'other'
      ? FOLDED_INTO_OTHER.reduce((sum, fuel) => sum + shareOf(fuel), 0)
      : shareOf(key)
  }));

  return {
    segments: folded.filter(segment => segment.percent > 0),
    all: [...byFuel.entries()]
      .map(([fuel, percent]) => ({ fuel, percent }))
      .sort((a, b) => b.percent - a.percent),
    zeroCarbon: ZERO_CARBON.reduce((sum, fuel) => sum + shareOf(fuel), 0)
  };
}

const ELEXON_WIND = ['WIND'];
const ELEXON_STORAGE = ['PS'];

/** The latest settlement period from Elexon's rolling day, in MW. */
export function foldElexon(rows) {
  const periods = Array.isArray(rows) ? rows.filter(row => Array.isArray(row?.data)) : [];
  if (!periods.length) return null;

  const latest = periods.reduce((newest, row) =>
    !newest || String(row.startTime) > String(newest.startTime) ? row : newest, null);

  const readings = latest.data.filter(entry => Number.isFinite(Number(entry?.generation)));
  if (!readings.length) return null;

  const sum = fuels => readings
    .filter(entry => fuels.includes(String(entry.fuelType).toUpperCase()))
    .reduce((total, entry) => total + Number(entry.generation), 0);

  return {
    at: latest.startTime,
    totalMw: readings.reduce((total, entry) => total + Number(entry.generation), 0),
    windMw: sum(ELEXON_WIND),
    storageMw: sum(ELEXON_STORAGE)
  };
}

/**
 * Sparkline geometry for the 24-hour line. The value domain is padded so a flat
 * day does not collapse onto the baseline, and the turning points come back
 * labelled so the chart can mark those two rather than every point.
 */
export function sparkline(points, { width = 340, height = 60, pad = 8 } = {}) {
  if (!Array.isArray(points) || points.length < 2) return null;

  const values = points.map(point => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const x = index => pad + (index * (width - pad * 2)) / (points.length - 1);
  const y = value => height - pad - ((value - min) / span) * (height - pad * 2);

  const coords = points.map((point, index) => ({ x: x(index), y: y(point.value), ...point }));
  const line = coords
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(' ');

  return {
    line,
    coords,
    min,
    max,
    lowest: coords[values.indexOf(min)],
    highest: coords[values.indexOf(max)],
    last: coords.at(-1),
    width,
    height
  };
}

/**
 * The reading nearest a position along the line, measured in the same viewBox
 * units the geometry is drawn in. The chart is stretched to the card, so a
 * caller scales a pointer's pixel offset into those units before asking.
 */
export function nearestIndex(coords, x) {
  if (!Array.isArray(coords) || !coords.length) return -1;

  let best = 0;
  for (let index = 1; index < coords.length; index += 1) {
    if (Math.abs(coords[index].x - x) < Math.abs(coords[best].x - x)) best = index;
  }
  return best;
}

/**
 * Whether a read is due. A tab left open holds the half hour it last fetched,
 * so coming back to it is worth a fresh read, but a tab flicked past twice in a
 * minute is not: nothing has settled in between.
 */
export function dueForRefresh(lastAt, now = Date.now(), floorMs = REFRESH_FLOOR_MS) {
  if (!Number.isFinite(lastAt) || lastAt <= 0) return true;
  return now - lastAt >= floorMs;
}

export const formatShare = percent => `${percent.toFixed(1)}%`;

/** Below a gigawatt this reads better as MW; above it, as GW. */
export function formatPower(mw) {
  if (!Number.isFinite(mw)) return 'n/a';
  return Math.abs(mw) >= 1000 ? `${(mw / 1000).toFixed(1)} GW` : `${Math.round(mw)} MW`;
}

/* ------------------------------------------------------------------ *
 * Everything below this line touches the DOM.
 * ------------------------------------------------------------------ */

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgElement(tag, attributes = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
  return node;
}

const clockOf = iso => timeFormatter.format(new Date(iso));
const dayOf = iso => dayFormatter.format(new Date(iso));
const longDayOf = iso => longDayFormatter.format(new Date(iso));

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: 'no-cache', signal: controller.signal });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function renderHero(intensity) {
  const hero = element('div', 'grid-now__hero');
  hero.append(element('p', 'grid-now__label', 'Carbon intensity'));

  const value = element('p', 'grid-now__value');
  value.append(element('strong', null, String(Math.round(intensity.value))));
  value.append(element('span', 'grid-now__unit', 'gCO₂/kWh'));
  hero.append(value);

  const meta = element('p', 'grid-now__index');
  const dot = element('span', 'grid-now__dot');
  dot.dataset.status = statusFor(intensity.index);
  meta.append(dot);

  // The index word is the only part that takes a capital, so it gets its own
  // span rather than a capitalize rule over the whole line.
  if (intensity.index) meta.append(element('span', 'grid-now__word', intensity.index));

  const window = intensity.to ? `half hour to ${clockOf(intensity.to)}` : 'latest half hour';
  meta.append(element('span', null,
    `${intensity.index ? '· ' : ''}${window}${intensity.measured ? '' : ', forecast'}`));
  hero.append(meta);

  return hero;
}

function renderSpark(points) {
  const geometry = sparkline(points);
  if (!geometry) return null;

  const figure = element('figure', 'grid-now__spark');

  // The caption keeps the label and carries the scrub readout beside it, rather
  // than a tooltip floating over a 60px-tall line: at this size a box near the
  // cursor covers the very stretch of line being read.
  const caption = element('figcaption', 'spark__head');
  caption.append(element('span', 'grid-now__label', 'Measured, past 24 hours'));
  const readout = element('span', 'spark__readout');
  readout.setAttribute('aria-live', 'polite');
  caption.append(readout);
  figure.append(caption);

  const svg = svgElement('svg', {
    class: 'spark',
    viewBox: `0 0 ${geometry.width} ${geometry.height}`,
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label':
      'Carbon intensity over the past 24 hours, ranging from ' +
      `${Math.round(geometry.min)} to ${Math.round(geometry.max)} grams of ` +
      'carbon dioxide per kilowatt hour.'
  });

  svg.append(svgElement('path', { class: 'spark__line', d: geometry.line }));
  svg.append(svgElement('circle', {
    class: 'spark__now',
    cx: geometry.last.x.toFixed(1),
    cy: geometry.last.y.toFixed(1),
    r: 4
  }));

  // The cursor sits in HTML over the chart rather than inside it: the viewBox is
  // stretched to the card width, so an SVG dot would draw as an ellipse.
  const plot = element('div', 'spark__plot');
  plot.append(svg);

  const cursor = element('div', 'spark__cursor');
  cursor.setAttribute('aria-hidden', 'true');
  cursor.append(element('div', 'spark__guide'));
  const dot = element('div', 'spark__dot');
  cursor.append(dot);
  plot.append(cursor);

  plot.tabIndex = 0;
  plot.setAttribute('aria-label',
    'Carbon intensity half hour by half hour. Use the left and right arrow keys ' +
    'to read each half hour.');

  let active = -1;

  const show = index => {
    const point = geometry.coords[index];
    if (!point || index === active) return;
    active = index;

    cursor.style.left = `${((point.x / geometry.width) * 100).toFixed(3)}%`;
    dot.style.top = `${((point.y / geometry.height) * 100).toFixed(3)}%`;
    cursor.classList.add('is-on');
    readout.textContent = `${clockOf(point.at)} · ${Math.round(point.value)} gCO₂/kWh`;
  };

  const clear = () => {
    active = -1;
    cursor.classList.remove('is-on');
    readout.textContent = '';
  };

  const readAt = event => {
    const box = plot.getBoundingClientRect();
    if (!box.width) return;
    show(nearestIndex(geometry.coords, ((event.clientX - box.left) / box.width) * geometry.width));
  };

  plot.addEventListener('pointermove', readAt);
  // A tap reads the half hour under the finger. Nothing calls preventDefault, so
  // the page still scrolls from a drag that starts on the chart - at which point
  // the browser cancels the pointer and the cursor clears itself.
  plot.addEventListener('pointerdown', readAt);
  plot.addEventListener('pointerleave', clear);
  plot.addEventListener('pointercancel', clear);

  const KEY_STEPS = {
    ArrowRight: 1, ArrowUp: 1,
    ArrowLeft: -1, ArrowDown: -1
  };

  plot.addEventListener('keydown', event => {
    const last = geometry.coords.length - 1;
    const from = active < 0 ? last : active;

    if (event.key === 'Home') show(0);
    else if (event.key === 'End') show(last);
    else if (event.key === 'Escape') clear();
    else if (KEY_STEPS[event.key]) {
      show(Math.min(last, Math.max(0, from + KEY_STEPS[event.key])));
    } else return;

    event.preventDefault();
  });

  // Focus lands on the latest reading, so tabbing here says something before any
  // key is pressed.
  plot.addEventListener('focus', () => show(geometry.coords.length - 1));
  plot.addEventListener('blur', clear);

  figure.append(plot);

  // Selective direct labels: the two turning points, never a number per point.
  const range = element('p', 'grid-now__range');
  range.append(element('span', null, `Low ${Math.round(geometry.min)} at ${clockOf(geometry.lowest.at)}`));
  range.append(element('span', null, `High ${Math.round(geometry.max)} at ${clockOf(geometry.highest.at)}`));
  figure.append(range);

  return figure;
}

/**
 * The site's own record. Its own block rather than a third pair of turning
 * points on the 24-hour line: that line's low and high are today's, while these
 * two are cumulative, and the two spans read as the same thing side by side.
 */
function renderRecords(records) {
  const block = element('div', 'grid-now__records');
  block.append(element('p', 'grid-now__label',
    `Recorded on this site, since ${longDayOf(`${records.since}T12:00Z`)}`));

  const list = element('dl', 'grid-now__stats');
  const stat = (term, reading) => {
    const cell = element('div', 'grid-now__stat');
    cell.append(element('dt', null, term));

    const value = element('dd');
    value.append(document.createTextNode(`${Math.round(reading.value)} `));
    value.append(element('span', 'grid-now__unit', 'gCO₂/kWh'));
    cell.append(value);

    // The moment is the point of a record, so it is printed rather than left to
    // a tooltip.
    cell.append(element('p', 'grid-now__when',
      `${clockOf(reading.at)}, ${dayOf(reading.at)}`));
    list.append(cell);
  };

  stat('Lowest recorded here', records.lowest);
  stat('Highest recorded here', records.highest);
  block.append(list);

  return block;
}

function renderMix(mix) {
  const block = element('div', 'grid-now__mix');

  const head = element('div', 'grid-now__mixhead');
  head.append(element('p', 'grid-now__label', 'Generation mix'));
  head.append(element('p', 'grid-now__zero', `${formatShare(mix.zeroCarbon)} zero-carbon`));
  block.append(head);

  const description = mix.segments
    .map(segment => `${segment.label} ${formatShare(segment.percent)}`)
    .join(', ');

  const bar = element('div', 'mixbar');
  bar.setAttribute('role', 'img');
  bar.setAttribute('aria-label', `Generation mix: ${description}.`);

  const legend = element('ul', 'mixlegend');

  mix.segments.forEach(segment => {
    const fill = element('span', 'mixbar__segment');
    fill.dataset.fuel = segment.key;
    fill.style.flexGrow = String(segment.percent);
    fill.title = `${segment.label}, ${formatShare(segment.percent)}`;
    bar.append(fill);

    const row = element('li', 'mixlegend__item');
    const swatch = element('span', 'mixlegend__swatch');
    swatch.dataset.fuel = segment.key;
    row.append(swatch);
    row.append(element('span', 'mixlegend__label', segment.label));
    row.append(element('span', 'mixlegend__value', formatShare(segment.percent)));
    legend.append(row);

    // Pointing at either half of a pair lifts the other, so a thin segment can
    // be identified without reading colour against colour.
    const highlight = on => {
      fill.classList.toggle('is-active', on);
      row.classList.toggle('is-active', on);
    };
    [fill, row].forEach(node => {
      node.addEventListener('pointerenter', () => highlight(true));
      node.addEventListener('pointerleave', () => highlight(false));
    });
  });

  block.append(bar);
  block.append(legend);
  block.append(renderMixTable(mix.all));

  return block;
}

/**
 * The table view. It carries the feed's own nine fuels rather than the seven
 * drawn above, so folding hydro and coal into "Other" costs the reader nothing.
 */
function renderMixTable(all) {
  const details = element('details', 'grid-now__table');
  details.append(element('summary', null, 'All fuels, as reported'));

  const table = element('table');

  const headRow = element('tr');
  ['Fuel', 'Share'].forEach((label, index) => {
    const cell = element('th', index === 1 ? 'is-numeric' : null, label);
    cell.setAttribute('scope', 'col');
    headRow.append(cell);
  });
  const head = element('thead');
  head.append(headRow);
  table.append(head);

  const body = element('tbody');
  all.forEach(row => {
    const tr = element('tr');
    const name = element('th', null,
      FUEL_LABELS[row.fuel] || row.fuel.replace(/^./, letter => letter.toUpperCase()));
    name.setAttribute('scope', 'row');
    tr.append(name);
    tr.append(element('td', 'is-numeric', formatShare(row.percent)));
    body.append(tr);
  });
  table.append(body);

  // Its own scroll container, so a narrow column can never push the table out
  // past the card and take the page's horizontal scrollbar with it.
  const scroller = element('div', 'grid-now__tablewrap');
  scroller.append(table);
  details.append(scroller);
  return details;
}

function renderMetered(metered) {
  const block = element('div', 'grid-now__metered');
  block.append(element('p', 'grid-now__label',
    `Transmission-metered output, half hour from ${clockOf(metered.at)}`));

  const list = element('dl', 'grid-now__stats');
  const stat = (term, value) => {
    const cell = element('div', 'grid-now__stat');
    cell.append(element('dt', null, term));
    cell.append(element('dd', null, value));
    list.append(cell);
  };

  stat('Metered generation', formatPower(metered.totalMw));
  stat('Wind', formatPower(metered.windMw));
  stat(metered.storageMw < 0 ? 'Pumped storage, pumping' : 'Pumped storage',
    formatPower(Math.abs(metered.storageMw)));
  block.append(list);

  block.append(element('p', 'grid-now__note',
    'Metered at transmission, so embedded solar and small wind sit outside these ' +
    'totals, which is why they do not reconcile with the shares above.'));

  return block;
}

function renderFoot() {
  const foot = element('p', 'grid-now__foot');
  foot.append(document.createTextNode('Live from '));

  const carbon = element('a', null, 'the National Grid ESO carbon intensity API');
  carbon.href = 'https://carbonintensity.org.uk/';
  const elexon = element('a', null, 'Elexon Insights');
  elexon.href = 'https://www.elexon.co.uk/data/';
  [carbon, elexon].forEach(link => {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  });

  foot.append(carbon);
  foot.append(document.createTextNode(' and '));
  foot.append(elexon);
  foot.append(document.createTextNode('. Both settle on the half hour.'));
  return foot;
}

function renderMessage(root, message) {
  root.replaceChildren(element('p', 'grid-now__status', message));
}

function render(root, { intensity, history, records, mix, metered }) {
  const fragment = document.createDocumentFragment();

  const top = element('div', 'grid-now__top');
  top.append(renderHero(intensity));
  const spark = renderSpark(history);
  if (spark) top.append(spark);
  fragment.append(top);

  // Beside the hero and the 24-hour line, where the reader is already looking
  // at intensity, rather than after the fuel and metering blocks.
  if (records) fragment.append(renderRecords(records));
  if (mix) fragment.append(renderMix(mix));
  if (metered) fragment.append(renderMetered(metered));
  fragment.append(renderFoot());

  root.replaceChildren(fragment);
}

/**
 * Each feed is settled separately: the strip is worth showing on whichever ones
 * answered, and Elexon going quiet should not blank the mix.
 */
async function load(root) {
  const historyUrl = `${API_INTENSITY}/${new Date().toISOString().slice(0, 19)}Z/pt24h`;

  const [intensityResult, historyResult, mixResult, elexonResult, recordsResult] =
    await Promise.allSettled([
      getJson(API_INTENSITY),
      getJson(historyUrl),
      getJson(API_MIX),
      getJson(API_ELEXON),
      getJson(RECORDS_FILE)
    ]);

  const valueOf = result => (result.status === 'fulfilled' ? result.value : null);

  const intensity = readIntensity(valueOf(intensityResult));
  if (!intensity) {
    renderMessage(root, 'The grid feeds are not answering right now.');
    return;
  }

  render(root, {
    intensity,
    history: readHistory(valueOf(historyResult)),
    records: readRecords(valueOf(recordsResult)),
    mix: foldMix(valueOf(mixResult)?.data?.generationmix),
    metered: foldElexon(valueOf(elexonResult))
  });
}

function init() {
  const root = document.getElementById('gridNow');
  if (!root) return;

  let lastAt = 0;

  const refresh = () => {
    lastAt = Date.now();
    return load(root).catch(error => {
      console.warn('GB grid strip unavailable:', error.message);
      renderMessage(root, 'The grid feeds are not answering right now.');
    });
  };

  refresh();

  // Only while the tab is in front: a background tab polling two public APIs
  // every five minutes is rude and buys nothing.
  setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, REFRESH_MS);

  // And on the way back to a tab, rather than waiting out the interval there:
  // the panel is about this half hour, so returning to one that has since
  // settled and reading a stale number is the failure worth avoiding.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && dueForRefresh(lastAt)) refresh();
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
