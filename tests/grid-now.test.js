import test from "node:test";
import assert from "node:assert/strict";
import {
  FUEL_ORDER,
  foldElexon,
  foldMix,
  formatPower,
  formatShare,
  REFRESH_FLOOR_MS,
  dueForRefresh,
  nearestIndex,
  readHistory,
  readRecords,
  readIntensity,
  sparkline,
  statusFor
} from "../js/grid-now.js";

// Shapes copied from live responses on 2026-09-07.
const intensityPayload = {
  data: [{
    from: "2026-09-07T19:00Z",
    to: "2026-09-07T19:30Z",
    intensity: { forecast: 93, actual: 133, index: "moderate" }
  }]
};

const mixPayload = [
  { perc: 8.1, fuel: "biomass" },
  { perc: 0, fuel: "coal" },
  { perc: 4.1, fuel: "imports" },
  { fuel: "gas", perc: 19.5 },
  { fuel: "nuclear", perc: 14.1 },
  { perc: 0, fuel: "other" },
  { fuel: "hydro", perc: 0 },
  { fuel: "solar", perc: 0 },
  { fuel: "wind", perc: 54.2 }
];

const elexonPayload = [
  {
    startTime: "2026-09-06T20:00:00Z",
    data: [{ fuelType: "WIND", generation: 12016 }, { fuelType: "PS", generation: 776 }]
  },
  {
    startTime: "2026-09-06T20:30:00Z",
    data: [
      { fuelType: "BIOMASS", generation: 2865 },
      { fuelType: "CCGT", generation: 6505 },
      { fuelType: "COAL", generation: 0 },
      { fuelType: "NUCLEAR", generation: 3569 },
      { fuelType: "PS", generation: 714 },
      { fuelType: "WIND", generation: 12143 }
    ]
  }
];

test("the settled reading wins, and is marked as measured", () => {
  const now = readIntensity(intensityPayload);
  assert.equal(now.value, 133);
  assert.equal(now.index, "moderate");
  assert.equal(now.measured, true);
});

test("a period with only a forecast is used, but flagged as one", () => {
  const now = readIntensity({
    data: [{ from: "x", to: "y", intensity: { forecast: 93, actual: null, index: "low" } }]
  });
  assert.equal(now.value, 93);
  assert.equal(now.measured, false);
});

test("a period carrying neither number is refused rather than drawn as zero", () => {
  assert.equal(readIntensity({ data: [{ intensity: { forecast: null, actual: null } }] }), null);
  assert.equal(readIntensity({}), null);
  assert.equal(readIntensity(null), null);
});

test("index words map onto the reserved status roles", () => {
  assert.equal(statusFor("very low"), "good");
  assert.equal(statusFor("low"), "good");
  assert.equal(statusFor("moderate"), "warning");
  assert.equal(statusFor("high"), "serious");
  assert.equal(statusFor("Very High"), "critical");
  assert.equal(statusFor("nonsense"), "unknown");
  assert.equal(statusFor(null), "unknown");
});

test("history keeps settled half hours and drops the forecast tail", () => {
  const points = readHistory({
    data: [
      { from: "2026-09-06T19:30Z", intensity: { actual: 111, forecast: 117 } },
      { from: "2026-09-06T20:00Z", intensity: { actual: 102, forecast: 119 } },
      { from: "2026-09-06T20:30Z", intensity: { actual: null, forecast: 109 } }
    ]
  });
  assert.deepEqual(points.map(point => point.value), [111, 102]);
  assert.equal(points[0].at, "2026-09-06T19:30Z");
});

test("the mix folds to the seven drawn segments and drops the zeroes", () => {
  const mix = foldMix(mixPayload);
  assert.deepEqual(
    mix.segments.map(segment => segment.key),
    ["wind", "nuclear", "biomass", "gas", "imports"]
  );
  // Segment order follows FUEL_ORDER, never the size of the shares: the palette
  // was validated against that order.
  const drawn = mix.segments.map(segment => FUEL_ORDER.indexOf(segment.key));
  assert.deepEqual(drawn, [...drawn].sort((a, b) => a - b));
});

test("hydro, coal and the feed's own other collapse into one Other segment", () => {
  const mix = foldMix([
    { fuel: "wind", perc: 80 },
    { fuel: "hydro", perc: 6 },
    { fuel: "coal", perc: 4 },
    { fuel: "other", perc: 10 }
  ]);
  const other = mix.segments.find(segment => segment.key === "other");
  assert.equal(other.percent, 20);
});

test("the table view keeps every fuel the feed reported, zeroes included", () => {
  const mix = foldMix(mixPayload);
  assert.equal(mix.all.length, 9);
  assert.equal(mix.all[0].fuel, "wind");
  assert.ok(mix.all.some(row => row.fuel === "coal" && row.percent === 0));
});

test("zero-carbon counts the four carbon-free fuels and excludes biomass", () => {
  const mix = foldMix(mixPayload);
  assert.equal(Number(mix.zeroCarbon.toFixed(1)), 68.3);   // wind + nuclear, solar and hydro at zero
});

test("an empty or malformed mix yields nothing to draw", () => {
  assert.equal(foldMix([]), null);
  assert.equal(foldMix(null), null);
  assert.equal(foldMix([{ fuel: "wind", perc: "not a number" }]), null);
});

test("Elexon folds to the newest settlement period", () => {
  const metered = foldElexon(elexonPayload);
  assert.equal(metered.at, "2026-09-06T20:30:00Z");
  assert.equal(metered.windMw, 12143);
  assert.equal(metered.storageMw, 714);
  assert.equal(metered.totalMw, 2865 + 6505 + 0 + 3569 + 714 + 12143);
});

test("Elexon rows without readings are refused", () => {
  assert.equal(foldElexon([]), null);
  assert.equal(foldElexon(null), null);
  assert.equal(foldElexon([{ startTime: "2026-09-06T20:00:00Z", data: [] }]), null);
});

test("sparkline spans the box and reports both turning points", () => {
  const geometry = sparkline(
    [
      { at: "a", value: 100 },
      { at: "b", value: 300 },
      { at: "c", value: 200 }
    ],
    { width: 100, height: 50, pad: 5 }
  );

  assert.equal(geometry.min, 100);
  assert.equal(geometry.max, 300);
  assert.equal(geometry.lowest.at, "a");
  assert.equal(geometry.highest.at, "b");
  assert.equal(geometry.last.at, "c");
  // Lowest sits on the padded floor, highest on the padded ceiling.
  assert.equal(geometry.lowest.y, 45);
  assert.equal(geometry.highest.y, 5);
  assert.ok(geometry.line.startsWith("M5.0 45.0"));
});

test("a flat day still draws a line rather than dividing by zero", () => {
  const geometry = sparkline([{ at: "a", value: 120 }, { at: "b", value: 120 }]);
  assert.ok(Number.isFinite(geometry.coords[0].y));
  assert.equal(geometry.coords[0].y, geometry.coords[1].y);
});

test("scrubbing snaps to the nearest half hour, and clamps past either end", () => {
  const { coords } = sparkline(
    [
      { at: "a", value: 100 },
      { at: "b", value: 300 },
      { at: "c", value: 200 }
    ],
    { width: 100, height: 50, pad: 5 }
  );

  // Points sit at x = 5, 50 and 95.
  assert.equal(nearestIndex(coords, 5), 0);
  assert.equal(nearestIndex(coords, 26), 0);
  assert.equal(nearestIndex(coords, 29), 1);
  assert.equal(nearestIndex(coords, 95), 2);
  // A pointer past the plot's edge reads the end point rather than nothing.
  assert.equal(nearestIndex(coords, -40), 0);
  assert.equal(nearestIndex(coords, 400), 2);
});

test("with no line there is nothing to scrub", () => {
  assert.equal(nearestIndex([], 10), -1);
  assert.equal(nearestIndex(null, 10), -1);
});

const recordsFile = {
  schema: 1,
  since: "2026-09-12",
  through: "2026-09-12",
  updated: "2026-09-12T13:22:45.612Z",
  lowest: { value: 29, at: "2026-09-12T12:30Z", index: "low" },
  highest: { value: 143, at: "2026-09-12T02:30Z", index: "moderate" }
};

test("the stored record is read whole", () => {
  const records = readRecords(recordsFile);
  assert.equal(records.since, "2026-09-12");
  assert.equal(records.lowest.value, 29);
  assert.equal(records.highest.at, "2026-09-12T02:30Z");
});

test("half a record, or a record of nothing, does not draw", () => {
  assert.equal(readRecords(null), null);
  assert.equal(readRecords({ ...recordsFile, highest: null }), null);
  assert.equal(readRecords({ ...recordsFile, since: undefined }), null);
  // A value the file cannot vouch for is not printed as a record.
  assert.equal(readRecords({ ...recordsFile, lowest: { value: null, at: "2026-09-12T12:30Z" } }), null);
  assert.equal(readRecords({ ...recordsFile, lowest: { value: 29, at: 1757680000 } }), null);
});

test("a tab returned to is read again, one flicked past is not", () => {
  const now = 1_757_680_000_000;

  // Never read, so there is nothing on screen to trust.
  assert.equal(dueForRefresh(0, now), true);
  assert.equal(dueForRefresh(null, now), true);

  assert.equal(dueForRefresh(now - 1_000, now), false, "a second ago settled nothing");
  assert.equal(dueForRefresh(now - REFRESH_FLOOR_MS + 1, now), false);
  assert.equal(dueForRefresh(now - REFRESH_FLOOR_MS, now), true);
  assert.equal(dueForRefresh(now - 20 * 60 * 1000, now), true, "a tab left open for 20 minutes");
});

test("a line needs two points", () => {
  assert.equal(sparkline([{ at: "a", value: 1 }]), null);
  assert.equal(sparkline([]), null);
  assert.equal(sparkline(null), null);
});

test("power reads as MW below a gigawatt and GW above it", () => {
  assert.equal(formatPower(714), "714 MW");
  assert.equal(formatPower(12143), "12.1 GW");
  assert.equal(formatPower(1000), "1.0 GW");
  assert.equal(formatPower(NaN), "n/a");
});

test("shares always carry one decimal", () => {
  assert.equal(formatShare(54.2), "54.2%");
  assert.equal(formatShare(0), "0.0%");
});
