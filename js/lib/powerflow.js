// js/lib/powerflow.js
//
// An AC power flow for the contingency demo, and the N-1 screen built on it.
//
// Full Newton-Raphson in polar coordinates, following the MATPOWER formulation
// so results can be checked against a reference case. Fourteen buses gives a
// Jacobian of at most 27x27, which solves in well under a millisecond, so the
// page re-solves on every interaction rather than reading a precomputed table.
//
// Deliberately not modelled, because the demo does not need them and modelling
// them badly would be worse than leaving them out:
//   - generator VAr limits (MATPOWER leaves enforce_q_lims off by default, and
//     the reference solution this is tested against was produced that way)
//   - the OPF layer: generation is fixed, so tripping a line redistributes flow
//     but never re-dispatches
//
// Pure functions only; tests/powerflow.test.js covers them against the IEEE
// case's own published solution.

const TWO_PI = Math.PI * 2;

/** Bus type codes, as they arrive in the IEEE/MATPOWER data. */
export const SLACK = 3;
export const PV = 2;
export const PQ = 1;

const deg2rad = deg => (deg * Math.PI) / 180;

/**
 * Per-branch admittance parameters in the four-terminal form:
 *
 *   [If]   [yff  yft] [Vf]
 *   [It] = [ytf  ytt] [Vt]
 *
 * The off-nominal tap sits entirely on the "from" side, which is the convention
 * the case data assumes - the three transformers here (4-7, 4-9, 5-6) all carry
 * a ratio below one.
 */
export function branchAdmittance(branch) {
  const denominator = branch.r * branch.r + branch.x * branch.x;
  // Series admittance ys = 1 / (r + jx).
  const gs = branch.r / denominator;
  const bs = -branch.x / denominator;

  // Total line charging, split half to each end.
  const bHalf = (branch.b || 0) / 2;

  const ratio = branch.ratio ? branch.ratio : 1;
  const shift = deg2rad(branch.shift || 0);
  const tapRe = ratio * Math.cos(shift);
  const tapIm = ratio * Math.sin(shift);
  const tapMagSq = tapRe * tapRe + tapIm * tapIm;

  // ytt = ys + j*b/2
  const yttRe = gs;
  const yttIm = bs + bHalf;

  // yff = ytt / |tap|^2
  const yffRe = yttRe / tapMagSq;
  const yffIm = yttIm / tapMagSq;

  // yft = -ys / conj(tap), ytf = -ys / tap
  const divide = (re, im, dRe, dIm) => {
    const d = dRe * dRe + dIm * dIm;
    return [(re * dRe + im * dIm) / d, (im * dRe - re * dIm) / d];
  };
  const [yftRe, yftIm] = divide(-gs, -bs, tapRe, -tapIm);
  const [ytfRe, ytfIm] = divide(-gs, -bs, tapRe, tapIm);

  return { yffRe, yffIm, yftRe, yftIm, ytfRe, ytfIm, yttRe, yttIm };
}

/** Branch indices that are in service, given a set of tripped ones. */
function liveBranches(net, outage) {
  const tripped = outage === null || outage === undefined
    ? new Set()
    : new Set(Array.isArray(outage) ? outage : [outage]);
  return net.branch
    .map((branch, index) => ({ branch, index }))
    .filter(({ branch, index }) => branch.status !== 0 && !tripped.has(index));
}

/**
 * Which buses the slack can still reach. A trip that islands part of the network
 * has no single-slack solution, and the demo has to say so rather than hand back
 * whatever the iteration happens to converge to - bus 8 in this case is fed by
 * one branch, so tripping 7-8 strands a generator.
 */
export function connectivity(net, outage) {
  const index = new Map(net.bus.map((bus, i) => [bus.id, i]));
  const neighbours = net.bus.map(() => []);

  liveBranches(net, outage).forEach(({ branch }) => {
    const f = index.get(branch.from);
    const t = index.get(branch.to);
    neighbours[f].push(t);
    neighbours[t].push(f);
  });

  const slack = net.bus.findIndex(bus => bus.type === SLACK);
  const seen = new Array(net.bus.length).fill(false);
  const queue = [slack];
  seen[slack] = true;

  while (queue.length) {
    const at = queue.pop();
    neighbours[at].forEach(next => {
      if (!seen[next]) {
        seen[next] = true;
        queue.push(next);
      }
    });
  }

  return {
    connected: seen.every(Boolean),
    reachable: seen,
    stranded: net.bus.filter((bus, i) => !seen[i]).map(bus => bus.id)
  };
}

/** Dense Ybus as separate conductance and susceptance matrices. */
export function buildYbus(net, outage) {
  const n = net.bus.length;
  const index = new Map(net.bus.map((bus, i) => [bus.id, i]));
  const G = Array.from({ length: n }, () => new Float64Array(n));
  const B = Array.from({ length: n }, () => new Float64Array(n));

  net.bus.forEach((bus, i) => {
    G[i][i] += (bus.gs || 0) / net.baseMVA;
    B[i][i] += (bus.bs || 0) / net.baseMVA;
  });

  liveBranches(net, outage).forEach(({ branch }) => {
    const f = index.get(branch.from);
    const t = index.get(branch.to);
    const y = branchAdmittance(branch);

    G[f][f] += y.yffRe; B[f][f] += y.yffIm;
    G[f][t] += y.yftRe; B[f][t] += y.yftIm;
    G[t][f] += y.ytfRe; B[t][f] += y.ytfIm;
    G[t][t] += y.yttRe; B[t][t] += y.yttIm;
  });

  return { G, B };
}

/** Scheduled injections in per-unit, with load scaled by the page's slider. */
function schedule(net, loadScale) {
  const index = new Map(net.bus.map((bus, i) => [bus.id, i]));
  const p = new Float64Array(net.bus.length);
  const q = new Float64Array(net.bus.length);

  net.bus.forEach((bus, i) => {
    p[i] -= (bus.pd * loadScale) / net.baseMVA;
    q[i] -= (bus.qd * loadScale) / net.baseMVA;
  });

  net.gen.forEach(gen => {
    if (gen.status === 0) return;
    const i = index.get(gen.bus);
    p[i] += gen.pg / net.baseMVA;
    // A PV bus regulates its own voltage, so its scheduled Q is not a
    // constraint; only PQ buses use this.
    q[i] += gen.qg / net.baseMVA;
  });

  return { p, q };
}

/** Gaussian elimination with partial pivoting. */
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => Float64Array.from([...row, b[i]]));

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
    }
    if (Math.abs(M[pivot][col]) < 1e-13) return null;   // singular
    if (pivot !== col) [M[col], M[pivot]] = [M[pivot], M[col]];

    for (let row = col + 1; row < n; row++) {
      const factor = M[row][col] / M[col][col];
      if (factor === 0) continue;
      for (let k = col; k <= n; k++) M[row][k] -= factor * M[col][k];
    }
  }

  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = M[row][n];
    for (let k = row + 1; k < n; k++) sum -= M[row][k] * x[k];
    x[row] = sum / M[row][row];
  }
  return x;
}

/** Injections implied by the current voltages. */
function injections(G, B, vm, va) {
  const n = vm.length;
  const p = new Float64Array(n);
  const q = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    let pi = 0;
    let qi = 0;
    for (let k = 0; k < n; k++) {
      const angle = va[i] - va[k];
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      pi += vm[k] * (G[i][k] * cos + B[i][k] * sin);
      qi += vm[k] * (G[i][k] * sin - B[i][k] * cos);
    }
    p[i] = vm[i] * pi;
    q[i] = vm[i] * qi;
  }
  return { p, q };
}

/**
 * Newton-Raphson AC power flow.
 *
 * Returns converged:false rather than throwing, because the caller screens
 * hundreds of outages and a non-converging one is a result, not an error.
 */
export function solvePowerFlow(net, { outage = null, loadScale = 1, tol = 1e-10, maxIter = 20 } = {}) {
  const island = connectivity(net, outage);
  if (!island.connected) {
    return { converged: false, islanded: true, stranded: island.stranded, iterations: 0 };
  }

  const n = net.bus.length;
  const { G, B } = buildYbus(net, outage);
  const { p: pSched, q: qSched } = schedule(net, loadScale);

  const genAt = new Map();
  net.gen.forEach(gen => { if (gen.status !== 0) genAt.set(gen.bus, gen); });

  const vm = new Float64Array(n);
  const va = new Float64Array(n);
  net.bus.forEach((bus, i) => {
    const gen = genAt.get(bus.id);
    // Flat start everywhere except the buses that hold a voltage.
    vm[i] = bus.type === PQ || !gen ? 1 : gen.vg;
    va[i] = 0;
  });

  const pvpq = [];   // angle unknowns
  const pq = [];     // magnitude unknowns
  net.bus.forEach((bus, i) => {
    if (bus.type !== SLACK) pvpq.push(i);
    if (bus.type === PQ) pq.push(i);
  });

  const nA = pvpq.length;
  const size = nA + pq.length;
  let iterations = 0;
  let converged = false;

  for (; iterations < maxIter; iterations++) {
    const { p, q } = injections(G, B, vm, va);

    const mismatch = new Float64Array(size);
    pvpq.forEach((i, row) => { mismatch[row] = pSched[i] - p[i]; });
    pq.forEach((i, row) => { mismatch[nA + row] = qSched[i] - q[i]; });

    let worst = 0;
    for (let i = 0; i < size; i++) worst = Math.max(worst, Math.abs(mismatch[i]));
    if (worst < tol) { converged = true; break; }

    // Jacobian, in the four standard blocks.
    const J = Array.from({ length: size }, () => new Float64Array(size));

    const dPdA = (i, j) => {
      if (i === j) return -q[i] - B[i][i] * vm[i] * vm[i];
      const a = va[i] - va[j];
      return vm[i] * vm[j] * (G[i][j] * Math.sin(a) - B[i][j] * Math.cos(a));
    };
    const dPdV = (i, j) => {
      if (i === j) return p[i] / vm[i] + G[i][i] * vm[i];
      const a = va[i] - va[j];
      return vm[i] * (G[i][j] * Math.cos(a) + B[i][j] * Math.sin(a));
    };
    const dQdA = (i, j) => {
      if (i === j) return p[i] - G[i][i] * vm[i] * vm[i];
      const a = va[i] - va[j];
      return -vm[i] * vm[j] * (G[i][j] * Math.cos(a) + B[i][j] * Math.sin(a));
    };
    const dQdV = (i, j) => {
      if (i === j) return q[i] / vm[i] - B[i][i] * vm[i];
      const a = va[i] - va[j];
      return vm[i] * (G[i][j] * Math.sin(a) - B[i][j] * Math.cos(a));
    };

    pvpq.forEach((i, row) => {
      pvpq.forEach((j, col) => { J[row][col] = dPdA(i, j); });
      pq.forEach((j, col) => { J[row][nA + col] = dPdV(i, j); });
    });
    pq.forEach((i, row) => {
      pvpq.forEach((j, col) => { J[nA + row][col] = dQdA(i, j); });
      pq.forEach((j, col) => { J[nA + row][nA + col] = dQdV(i, j); });
    });

    const step = solveLinear(J, mismatch);
    if (!step) return { converged: false, singular: true, iterations };

    pvpq.forEach((i, row) => { va[i] += step[row]; });
    pq.forEach((i, row) => { vm[i] += step[nA + row]; });
  }

  const buses = net.bus.map((bus, i) => ({
    id: bus.id,
    type: bus.type,
    vm: vm[i],
    va: (((va[i] * 180) / Math.PI + 180) % 360) - 180,
    vmin: bus.vmin,
    vmax: bus.vmax
  }));

  return {
    converged,
    islanded: false,
    iterations,
    buses,
    branches: branchFlows(net, vm, va, outage),
    ...totals(net, vm, va, outage, loadScale)
  };
}

/** Per-branch complex flows at both ends, in MVA, plus loading against rating. */
export function branchFlows(net, vm, va, outage) {
  const index = new Map(net.bus.map((bus, i) => [bus.id, i]));
  const live = new Set(liveBranches(net, outage).map(({ index: i }) => i));

  return net.branch.map((branch, i) => {
    if (!live.has(i)) {
      return { index: i, from: branch.from, to: branch.to, out: true, mva: 0, loading: 0 };
    }

    const f = index.get(branch.from);
    const t = index.get(branch.to);
    const y = branchAdmittance(branch);

    const vfRe = vm[f] * Math.cos(va[f]);
    const vfIm = vm[f] * Math.sin(va[f]);
    const vtRe = vm[t] * Math.cos(va[t]);
    const vtIm = vm[t] * Math.sin(va[t]);

    // If = yff*Vf + yft*Vt
    const ifRe = y.yffRe * vfRe - y.yffIm * vfIm + y.yftRe * vtRe - y.yftIm * vtIm;
    const ifIm = y.yffRe * vfIm + y.yffIm * vfRe + y.yftRe * vtIm + y.yftIm * vtRe;
    // It = ytf*Vf + ytt*Vt
    const itRe = y.ytfRe * vfRe - y.ytfIm * vfIm + y.yttRe * vtRe - y.yttIm * vtIm;
    const itIm = y.ytfRe * vfIm + y.ytfIm * vfRe + y.yttRe * vtIm + y.yttIm * vtRe;

    // S = V * conj(I)
    const pFrom = (vfRe * ifRe + vfIm * ifIm) * net.baseMVA;
    const qFrom = (vfIm * ifRe - vfRe * ifIm) * net.baseMVA;
    const pTo = (vtRe * itRe + vtIm * itIm) * net.baseMVA;
    const qTo = (vtIm * itRe - vtRe * itIm) * net.baseMVA;

    const mvaFrom = Math.hypot(pFrom, qFrom);
    const mvaTo = Math.hypot(pTo, qTo);
    const mva = Math.max(mvaFrom, mvaTo);

    return {
      index: i,
      from: branch.from,
      to: branch.to,
      out: false,
      isTransformer: Boolean(branch.ratio),
      pFrom, qFrom, pTo, qTo,
      mva,
      rating: branch.rateA || 0,
      loading: branch.rateA ? mva / branch.rateA : 0
    };
  });
}

function totals(net, vm, va, outage, loadScale) {
  const flows = branchFlows(net, vm, va, outage);
  const losses = flows
    .filter(flow => !flow.out)
    .reduce((sum, flow) => sum + flow.pFrom + flow.pTo, 0);

  return {
    lossesMw: losses,
    loadMw: net.bus.reduce((sum, bus) => sum + bus.pd, 0) * loadScale
  };
}

/** Buses outside their voltage band and branches over rating. */
export function violations(result) {
  if (!result.converged) return { voltage: [], overload: [], count: 0 };

  const voltage = result.buses
    .filter(bus => bus.vm > bus.vmax + 1e-9 || bus.vm < bus.vmin - 1e-9)
    .map(bus => ({
      id: bus.id,
      vm: bus.vm,
      kind: bus.vm > bus.vmax ? 'high' : 'low',
      limit: bus.vm > bus.vmax ? bus.vmax : bus.vmin
    }));

  const overload = result.branches
    .filter(flow => !flow.out && flow.rating && flow.loading > 1 + 1e-9)
    .map(flow => ({ index: flow.index, from: flow.from, to: flow.to, loading: flow.loading }));

  return { voltage, overload, count: voltage.length + overload.length };
}

/**
 * The severity index the ranking uses.
 *
 * This is the textbook active-power performance index: the sum over branches of
 * (flow / rating) raised to 2n. Raising the ratio to a high power is what makes
 * it a *screen* - one branch at 120% dominates twenty at 60%, so sorting by PI
 * puts the outages worth a full study at the top of the list. Its well-known
 * weakness is masking: many moderately loaded branches can out-score a single
 * genuine overload, which is exactly the failure mode a learned ranking is meant
 * to fix.
 */
export function performanceIndex(result, { n = 2 } = {}) {
  if (!result.converged) return Infinity;
  return result.branches
    .filter(flow => !flow.out && flow.rating)
    .reduce((sum, flow) => sum + Math.pow(flow.loading, 2 * n), 0);
}

/**
 * Screen every single-branch outage and rank by severity. Twenty branches means
 * twenty power flows, which is a few milliseconds - small enough to redo on
 * every slider move.
 */
export function screenContingencies(net, { loadScale = 1 } = {}) {
  return net.branch
    .map((branch, index) => {
      const result = solvePowerFlow(net, { outage: index, loadScale });
      const found = violations(result);
      return {
        index,
        from: branch.from,
        to: branch.to,
        isTransformer: Boolean(branch.ratio),
        islanded: Boolean(result.islanded),
        stranded: result.stranded || [],
        converged: result.converged,
        pi: performanceIndex(result),
        violations: found,
        worstLoading: result.converged
          ? Math.max(0, ...result.branches.filter(f => !f.out && f.rating).map(f => f.loading))
          : 0
      };
    })
    .sort((a, b) => {
      // An islanding trip is the most severe thing a single outage can do here,
      // and it has no PI at all, so it sorts to the top on its own terms.
      if (a.islanded !== b.islanded) return a.islanded ? -1 : 1;
      return b.pi - a.pi;
    });
}

export { TWO_PI };
