// scripts/build-feeder33.mjs
//
// Builds data/feeder33.json: the 33-bus radial distribution feeder of Baran and
// Wu (1989), in the same case schema js/lib/powerflow.js already reads.
//
// Often called the "IEEE 33-bus system" because it was published in IEEE
// Transactions on Power Delivery. It is not one of the IEEE PES distribution
// test feeders (those are the 4, 13, 34, 37 and 123-node cases), so it is named
// here by its authors.
//
// The line and load table below is the case as MATPOWER distributes it
// (data/case33bw.m), which cites the paper, and tests/battery.test.js pins every
// value to that table. The published data is in ohms on a 12.66 kV base;
// everything here converts it to per unit on a 10 MVA base. The five normally
// open tie switches are left out, because they carry nothing in the radial
// configuration this page solves. Branch ratings are not part of the case and
// are assumed; see ratingsNote. The slack voltage is changed; see
// voltageBandNote.
//
// Validate with: node --test tests/battery.test.js

import { writeFile } from 'node:fs/promises';

const KV = 12.66;
const BASE_MVA = 10;
const Z_BASE = (KV * KV) / BASE_MVA;   // 16.0276 ohm

// from, to, R ohm, X ohm, and the P kW / Q kVAr drawn at the receiving bus.
const LINES = [
  [1, 2, 0.0922, 0.0470, 100, 60],
  [2, 3, 0.4930, 0.2511, 90, 40],
  [3, 4, 0.3660, 0.1864, 120, 80],
  [4, 5, 0.3811, 0.1941, 60, 30],
  [5, 6, 0.8190, 0.7070, 60, 20],
  [6, 7, 0.1872, 0.6188, 200, 100],
  [7, 8, 0.7114, 0.2351, 200, 100],
  [8, 9, 1.0300, 0.7400, 60, 20],
  [9, 10, 1.0440, 0.7400, 60, 20],
  [10, 11, 0.1966, 0.0650, 45, 30],
  [11, 12, 0.3744, 0.1238, 60, 35],
  [12, 13, 1.4680, 1.1550, 60, 35],
  [13, 14, 0.5416, 0.7129, 120, 80],
  [14, 15, 0.5910, 0.5260, 60, 10],
  [15, 16, 0.7463, 0.5450, 60, 20],
  [16, 17, 1.2890, 1.7210, 60, 20],
  [17, 18, 0.7320, 0.5740, 90, 40],
  [2, 19, 0.1640, 0.1565, 90, 40],
  [19, 20, 1.5042, 1.3554, 90, 40],
  [20, 21, 0.4095, 0.4784, 90, 40],
  [21, 22, 0.7089, 0.9373, 90, 40],
  [3, 23, 0.4512, 0.3083, 90, 50],
  [23, 24, 0.8980, 0.7091, 420, 200],
  [24, 25, 0.8960, 0.7011, 420, 200],
  [6, 26, 0.2030, 0.1034, 60, 25],
  [26, 27, 0.2842, 0.1447, 60, 25],
  [27, 28, 1.0590, 0.9337, 60, 20],
  [28, 29, 0.8042, 0.7006, 120, 70],
  [29, 30, 0.5075, 0.2585, 200, 600],
  [30, 31, 0.9744, 0.9630, 150, 70],
  [31, 32, 0.3105, 0.3619, 210, 100],
  [32, 33, 0.3410, 0.5302, 60, 40]
];

const load = new Map(LINES.map(([, to, , , p, q]) => [to, { p, q }]));

// GB statutory limits for a high-voltage supply below 132 kV are +/- 6 per cent
// (ESQCR 2002, regulation 27), applied here as though this 12.66 kV case were an
// 11 kV GB circuit. The case's own published solution sits below that at the far
// end of the trunk.
const VMIN = 0.94;
const VMAX = 1.06;

const bus = Array.from({ length: 33 }, (_, i) => {
  const id = i + 1;
  const { p = 0, q = 0 } = load.get(id) || {};
  return {
    id,
    type: id === 1 ? 3 : 1,
    pd: p / 1000,
    qd: q / 1000,
    gs: 0,
    bs: 0,
    vmax: VMAX,
    vmin: VMIN,
    name: id === 1 ? 'Primary substation' : `Bus ${id}`
  };
});

const branch = LINES.map(([from, to, r, x]) => ({
  from,
  to,
  r: r / Z_BASE,
  x: x / Z_BASE,
  b: 0,
  ratio: 0,
  shift: 0,
  status: 1,
  rateA: 0          // filled in below, once the base case is known
}));

// The primary substation busbar. The published case holds it at 1.00 pu, which
// leaves the far end of the trunk at 0.913 pu at full load, and below the GB
// band whenever load is above about 71 per cent of the published case - nearly
// every half-hour of a typical GB day, because the case was built to study
// reconfiguration, not to represent GB operation. A GB primary has an on-load
// tap changer and targets a little above nominal for exactly this reason. At
// 1.02 pu the band is breached only above about 95 per cent of the published
// load, which is the constraint pattern a DNO actually plans against.
const SLACK_VG = 1.02;

const gen = [{ bus: 1, pg: 0, qg: 0, qmax: 99, qmin: -99, vg: SLACK_VG, status: 1 }];

const net = {
  name: 'Baran-Wu 33-bus distribution feeder',
  baseKV: KV,
  baseMVA: BASE_MVA,
  bus,
  gen,
  branch
};

// Ratings: assumed, because the published case has none. Set from base-case flow
// so the intact feeder is inside its thermal limits at full load with headroom,
// and rounded to plausible switchgear/cable steps.
const { solvePowerFlow } = await import('../js/lib/powerflow.js');
const base = solvePowerFlow(net, {});
if (!base.converged) throw new Error('base case did not converge');

const STEPS = [1.5, 2.5, 4, 6, 8];
net.branch.forEach((br, i) => {
  const flow = base.branches[i].mva;
  br.rateA = STEPS.find(step => step >= flow * 1.35) ?? Math.ceil(flow * 1.35);
});

net.ratingsNote =
  'Thermal ratings are not part of the Baran-Wu data, which lists none. These ' +
  'are assumed: the smallest of a set of plausible steps (1.5, 2.5, 4, 6, 8 MVA) ' +
  'that leaves at least 35 per cent headroom over base-case flow, so the intact ' +
  'feeder at full load is within limits and the demonstration is not decided by ' +
  'a rating chosen to make a point.';
net.voltageBandNote =
  'The band is 0.94-1.06 pu, the GB statutory limit for a high-voltage supply ' +
  'below 132 kV (ESQCR 2002, regulation 27), applied as though this 12.66 kV case ' +
  'were an 11 kV GB circuit. One value is changed from the published case: the ' +
  'primary substation busbar is held at ' + SLACK_VG.toFixed(2) + ' pu rather ' +
  'than 1.00 pu, because a GB primary has an on-load tap changer and targets above ' +
  'nominal to hold the far end of the feeder up. At 1.00 pu the published case ' +
  'sits at 0.913 pu at bus 18 at full load and falls below the band whenever load ' +
  'is above about 71 per cent of the published case. At ' + SLACK_VG.toFixed(2) +
  ' pu it falls below the band only above about 95 per cent - the constraint ' +
  'pattern a distribution planner actually works against. Impedances, loads and ' +
  'the radial topology are unaltered.';
net.tapNote =
  'Worth stating plainly: a tap change is the cheapest lever a DNO has. Moving ' +
  'the primary from 1.00 to 1.02 pu lifts the whole feeder by 0.020 to 0.022 pu, ' +
  'using equipment that is already installed. A battery should be judged against ' +
  'that baseline, not against an untapped network.';

await writeFile(
  new URL('../data/feeder33.json', import.meta.url),
  `${JSON.stringify(net, null, 2)}\n`
);

const vmin = Math.min(...base.buses.map(b => b.vm));
const worst = base.buses.find(b => b.vm === vmin);
console.log(`buses ${net.bus.length}  branches ${net.branch.length}`);
console.log(`total load ${(net.bus.reduce((s, b) => s + b.pd, 0) * 1000).toFixed(0)} kW / ` +
            `${(net.bus.reduce((s, b) => s + b.qd, 0) * 1000).toFixed(0)} kVAr`);
console.log(`losses ${(base.lossesMw * 1000).toFixed(1)} kW at ${SLACK_VG.toFixed(2)} pu slack`);
console.log(`Vmin ${vmin.toFixed(4)} pu at bus ${worst.id}`);

// The published-case check: at 1.00 pu slack this must reproduce Baran and Wu.
const asPublished = JSON.parse(JSON.stringify(net));
asPublished.gen[0].vg = 1.0;
const check = solvePowerFlow(asPublished, {});
const checkVmin = Math.min(...check.buses.map(b => b.vm));
console.log(`--- at the published 1.00 pu slack, for validation ---`);
console.log(`losses ${(check.lossesMw * 1000).toFixed(1)} kW   (published: 202.7 kW)`);
console.log(`Vmin ${checkVmin.toFixed(4)} pu   (published: 0.9131 at bus 18)`);
console.log(`iterations ${check.iterations}`);
