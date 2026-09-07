import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  branchAdmittance,
  buildYbus,
  connectivity,
  performanceIndex,
  screenContingencies,
  solvePowerFlow,
  violations
} from "../js/lib/powerflow.js";

const net = JSON.parse(readFileSync(new URL("../data/case14.json", import.meta.url), "utf8"));

/**
 * The reference is the case file's own Vm/Va columns, which arrive from the IEEE
 * Common Data Format carrying the converged solution. They are published to
 * three decimals, so 2e-3 pu is the tightest a fair comparison can be.
 */
test("the base case matches the published IEEE solution", () => {
  const result = solvePowerFlow(net);
  assert.equal(result.converged, true);
  assert.ok(result.iterations <= 6, `took ${result.iterations} iterations`);

  result.buses.forEach((bus, i) => {
    assert.ok(Math.abs(bus.vm - net.bus[i].vmSolved) < 2e-3,
      `bus ${bus.id} |V| ${bus.vm.toFixed(5)} vs published ${net.bus[i].vmSolved}`);
    assert.ok(Math.abs(bus.va - net.bus[i].vaSolved) < 5e-2,
      `bus ${bus.id} angle ${bus.va.toFixed(4)} vs published ${net.bus[i].vaSolved}`);
  });
});

test("base-case losses match the figure this case is known for", () => {
  // 13.39 MW on 259 MW of load.
  assert.ok(Math.abs(solvePowerFlow(net).lossesMw - 13.393) < 0.01);
});

test("the slack takes up generation, load and losses exactly", () => {
  const result = solvePowerFlow(net);
  const scheduled = net.gen.filter(g => g.bus !== 1).reduce((sum, g) => sum + g.pg, 0);
  // Everything leaving bus 1 has to be the shortfall plus the losses.
  const slackFlow = result.branches
    .filter(f => !f.out && (f.from === 1 || f.to === 1))
    .reduce((sum, f) => sum + (f.from === 1 ? f.pFrom : f.pTo), 0);

  assert.ok(Math.abs(slackFlow - (result.loadMw + result.lossesMw - scheduled)) < 1e-6);
});

test("voltage-controlled buses hold their scheduled voltage", () => {
  const result = solvePowerFlow(net);
  net.gen.forEach(gen => {
    const bus = result.buses.find(b => b.id === gen.bus);
    assert.ok(Math.abs(bus.vm - gen.vg) < 1e-9, `bus ${gen.bus} drifted off its setpoint`);
  });
});

test("the intact network is secure, which is what makes an outage's damage its own", () => {
  const found = violations(solvePowerFlow(net));
  assert.equal(found.count, 0);
});

test("a transformer's off-nominal tap sits on the from side", () => {
  const y = branchAdmittance({ r: 0, x: 0.20912, b: 0, ratio: 0.978, shift: 0 });
  const plain = branchAdmittance({ r: 0, x: 0.20912, b: 0, ratio: 0, shift: 0 });
  // yff scales by 1/tau^2 while ytt is untouched.
  assert.ok(Math.abs(y.yffIm - plain.yttIm / 0.978 ** 2) < 1e-12);
  assert.ok(Math.abs(y.yttIm - plain.yttIm) < 1e-12);
});

test("Ybus is symmetric when nothing shifts phase", () => {
  const { G, B } = buildYbus(net);
  for (let i = 0; i < G.length; i++) {
    for (let j = 0; j < G.length; j++) {
      assert.ok(Math.abs(G[i][j] - G[j][i]) < 1e-12);
      assert.ok(Math.abs(B[i][j] - B[j][i]) < 1e-12);
    }
  }
});

test("dropping a branch removes it from Ybus", () => {
  const intact = buildYbus(net);
  const without = buildYbus(net, 0);   // branch 0 is 1-2
  assert.notEqual(intact.B[0][1], 0);
  assert.equal(without.B[0][1], 0);
});

test("bus 8 is fed by one branch, so losing it strands a generator", () => {
  const sevenEight = net.branch.findIndex(b => b.from === 7 && b.to === 8);
  const island = connectivity(net, sevenEight);
  assert.equal(island.connected, false);
  assert.deepEqual(island.stranded, [8]);

  // And the solver refuses rather than returning a meaningless answer.
  const result = solvePowerFlow(net, { outage: sevenEight });
  assert.equal(result.converged, false);
  assert.equal(result.islanded, true);
});

test("every other single outage leaves the network whole", () => {
  net.branch.forEach((branch, index) => {
    if (branch.from === 7 && branch.to === 8) return;
    assert.equal(connectivity(net, index).connected, true, `${branch.from}-${branch.to} islanded`);
  });
});

test("flows balance: what leaves one end arrives at the other, minus losses", () => {
  const result = solvePowerFlow(net);
  result.branches.filter(f => !f.out).forEach(flow => {
    const loss = flow.pFrom + flow.pTo;
    assert.ok(loss >= -1e-9, `${flow.from}-${flow.to} generates power`);
    assert.ok(loss < 12, `${flow.from}-${flow.to} loses an implausible ${loss.toFixed(1)} MW`);
  });
});

test("lossless transformers lose nothing", () => {
  const result = solvePowerFlow(net);
  result.branches
    .filter(f => !f.out && f.isTransformer)
    .forEach(flow => assert.ok(Math.abs(flow.pFrom + flow.pTo) < 1e-9));
});

test("heavier load draws more loss, and the relationship is superlinear", () => {
  const light = solvePowerFlow(net, { loadScale: 0.8 });
  const base = solvePowerFlow(net, { loadScale: 1.0 });
  const heavy = solvePowerFlow(net, { loadScale: 1.2 });

  assert.ok(light.lossesMw < base.lossesMw);
  assert.ok(base.lossesMw < heavy.lossesMw);
  assert.ok(heavy.lossesMw - base.lossesMw > base.lossesMw - light.lossesMw);
});

test("the index rewards one bad branch over many mediocre ones", () => {
  const oneBad = { converged: true, branches: [
    { out: false, rating: 100, loading: 1.5 },
    { out: false, rating: 100, loading: 0.1 }
  ] };
  const severalFine = { converged: true, branches: Array.from({ length: 8 }, () => (
    { out: false, rating: 100, loading: 0.8 }
  )) };
  assert.ok(performanceIndex(oneBad) > performanceIndex(severalFine));
});

test("an outage that does not converge scores as infinitely severe, not as safe", () => {
  assert.equal(performanceIndex({ converged: false }), Infinity);
});

test("the screen ranks every branch and puts the islanding trip first", () => {
  const ranked = screenContingencies(net);
  assert.equal(ranked.length, net.branch.length);
  assert.equal(ranked[0].islanded, true);
  assert.deepEqual(ranked[0].stranded, [8]);

  const rest = ranked.filter(c => !c.islanded);
  rest.forEach((c, i) => {
    if (i === 0) return;
    assert.ok(rest[i - 1].pi >= c.pi, "ranking is not monotonic in the index");
  });
});

test("at base load the index separates the harmful outages cleanly", () => {
  const ranked = screenContingencies(net).filter(c => !c.islanded);
  const lastHarmful = ranked.reduce(
    (last, c, i) => (c.violations.overload.length ? i : last), -1);
  const firstClean = ranked.findIndex(c => c.violations.overload.length === 0);
  assert.ok(firstClean > lastHarmful, "a clean outage outranked a harmful one at base load");
});

/**
 * Masking is the failure this screen is known for, and it is not hypothetical
 * here: raise the load and the index sorts a genuinely harmful outage below a
 * harmless one, because many mid-loaded branches out-score a single overload.
 * The page shows this happening, so it is pinned down by a test.
 */
test("at 110% load the index misranks, which is the point the demo makes", () => {
  const ranked = screenContingencies(net, { loadScale: 1.1 }).filter(c => !c.islanded);
  const lastHarmful = ranked.reduce(
    (last, c, i) => (c.violations.overload.length ? i : last), -1);
  const firstClean = ranked.findIndex(c => c.violations.overload.length === 0);

  assert.ok(firstClean >= 0 && lastHarmful > firstClean,
    "expected a harmless outage to outrank a harmful one at 110% load");
});
