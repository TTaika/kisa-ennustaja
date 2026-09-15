// Discrete-event simulator for the race.
//
// Concept:
//  - Tasks are first-class entities with their own slots and durations.
//  - Routes are owned by Courses (reusable, shared across categories via
//    category.courseId), not by categories directly. Each course stop is an
//    ordered CP visit: { cpId, distanceM, taskIds, parallel }.
//  - Each (cpId, taskId) pair is a "task instance" with its own slot pool
//    and FIFO of waiters. Categories that share the same task at the same
//    CP — including across categories sharing a course — share that pool.
//  - A single event queue (sorted array) drives the simulation.
//  - Events: ARRIVE (team reaches the next task at a CP) and
//            FINISH (team's task ends).
//  - When a team arrives at a task instance:
//      * if the task is unlimited → it starts immediately.
//      * else if no one is waiting AND a slot is free → it starts.
//      * else it enqueues at the back of the FIFO.
//  - When a task instance finishes:
//      * if a waiter exists and a slot is now free → start the waiter.
//      * the just-finished team advances to the next task at the same CP,
//        or, if all of this stop's tasks are done, walks to the next stop
//        (or, if this CP is flagged a Yörasti — an overnight stop — restarts
//        at startMinutes2 + N days, where N is how many Yörasti CPs this
//        team has now passed through; a course can pass through any number
//        of them in sequence to build a race of any length).
//  - At the same wall-clock instant, FINISH events fire before ARRIVE events
//    so existing waiters get a freed slot before brand-new arrivals.
//
// Häröilyaika (replaces v1's flat per-category transitMin): every task a
// team completes adds course.haroilyBaselineMin + task.haroilyMin to that
// task's leaveMin — a REAL delay before the next task/CP is reached, not
// just a cosmetic number. The task's own slot is released the instant its
// raw completion time ends; häröily happens strictly after that release and
// never holds or is held by the slot. At a stop with 2+ sequential tasks,
// each one gets its own häröily added in turn. At a parallel-tasks stop, the
// team departs once every task is both finished AND packed up — i.e. at
// max(taskEnd_i + häröily_i) across the stop's tasks, not sum(häröily_i).
//
// Overnight is derived, not stored: a stop triggers a day-boundary restart
// whenever its cpId matches a CP flagged isSleepingCp (a "Yörasti"). Any
// number of CPs may be flagged — a course can pass through several in
// sequence for a multi-day race — each one advances that team by one more
// calendar day, always restarting at the same startMinutes2 clock time.
//
// withdrawnTeamIndices (DNS/DNF): those team numbers are never created, so
// they never touch queues, slots, or stats.
//
// Output:
//   {
//     teams: [{ id, label, catId, catName, catColor,
//               stops: [{ cpId, cpName, taskId, taskName,
//                         walkMin, arriveMin, waitMin, startMin,
//                         taskMin, endMin, leaveMin }] }],
//     taskStats: [{ cpId, cpName, taskId, taskName,
//                   slots, unlimitedSlots, arrivalCount,
//                   firstArrivalMin, lastArrivalMin,
//                   firstLeaveMin, lastLeaveMin,
//                   peakWaiting, peakAtMin, totalWaitMin, worstWaitMin }]
//   }
//
// `walkMin` is non-zero only on the first task of each CP visit (transit
// from the previous CP).

const FINISH = 0;   // lower priority value = fired first at same instant
const ARRIVE = 1;

// Acklam's rational approximation of the inverse standard-normal CDF.
function inverseNormal(p) {
  const a1 = -3.969683028665376e+01, a2 =  2.209460984245205e+02;
  const a3 = -2.759285104469687e+02, a4 =  1.383577518672690e+02;
  const a5 = -3.066479806614716e+01, a6 =  2.506628277459239e+00;
  const b1 = -5.447609879822406e+01, b2 =  1.615858368580409e+02;
  const b3 = -1.556989798598866e+02, b4 =  6.680131188771972e+01;
  const b5 = -1.328068155288572e+01;
  const c1 = -7.784894002430293e-03, c2 = -3.223964580411365e-01;
  const c3 = -2.400758277161838e+00, c4 = -2.549732539343734e+00;
  const c5 =  4.374664141464968e+00, c6 =  2.938163982698783e+00;
  const d1 =  7.784695709041462e-03, d2 =  3.224671290700398e-01;
  const d3 =  2.445134137142996e+00, d4 =  3.754408661907416e+00;
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c1*q + c2)*q + c3)*q + c4)*q + c5)*q + c6) /
           ((((d1*q + d2)*q + d3)*q + d4)*q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5; r = q * q;
    return (((((a1*r + a2)*r + a3)*r + a4)*r + a5)*r + a6) * q /
           (((((b1*r + b2)*r + b3)*r + b4)*r + b5)*r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c1*q + c2)*q + c3)*q + c4)*q + c5)*q + c6) /
          ((((d1*q + d2)*q + d3)*q + d4)*q + 1);
}

// FNV-1a 32-bit hash. Deterministic; used to produce stable per-(team,task)
// perturbations so that re-running the simulator gives identical numbers.
function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Deterministic standard-normal sample for (teamId, taskId): same inputs →
// same output. Mean 0, std 1; used to add per-task fitness noise so the
// global-fastest team isn't necessarily the fastest at every single task.
function deterministicNoise(teamId, taskId) {
  const seed = fnv1a(`${teamId}::${taskId}`);
  const p = (seed % 100000 + 0.5) / 100000;
  return inverseNormal(p);
}

// Returns a per-team "fitness" position in [0, 1]. The slowest team (index
// 0) always maps to 0 and the fastest (N-1) to 1; the middle of the curve
// is shaped by `curve` and `sharpness`:
//   "normal" (default) — symmetric bell, middle teams cluster around 0.5
//                        sharpness > 1 → tighter cluster
//                        sharpness < 1 → looser, approaching linear
//   "linear"           — evenly spaced steps (sharpness ignored)
//   "power"            — skewed; sharpness IS the exponent applied to the
//                        linear position u = i/(N-1)
export function teamFitness(teamIdx, teamCount, curve = "normal", sharpness = 1) {
  if (teamCount <= 1) return 0.5;
  const s = (Number.isFinite(sharpness) && sharpness > 0) ? sharpness : 1;

  if (curve === "linear") {
    return teamIdx / (teamCount - 1);
  }
  if (curve === "power") {
    const u = teamIdx / (teamCount - 1);
    return Math.pow(u, s);
  }
  const z   = inverseNormal((teamIdx + 0.5) / teamCount);
  const zLo = inverseNormal(0.5 / teamCount);
  const zHi = inverseNormal((teamCount - 0.5) / teamCount);
  const reshape = v => Math.sign(v) * Math.pow(Math.abs(v), s);
  const zS   = reshape(z);
  const zLoS = reshape(zLo);
  const zHiS = reshape(zHi);
  if (zHiS === zLoS) return 0.5;
  return (zS - zLoS) / (zHiS - zLoS);
}

// Convenience wrapper kept for backwards-compatible callers/tests.
export function teamSpeedMultiplier(teamIdx, teamCount, slowestMul, fastestMul, curve = "normal", sharpness = 1) {
  const f = teamFitness(teamIdx, teamCount, curve, sharpness);
  return slowestMul + f * (fastestMul - slowestMul);
}

export function simulateRace(controlPoints, tasks, courses, categories, options = {}) {
  const disableQueueing       = !!options.disableQueueing;
  const fitnessCurve          = options.fitnessCurve || "normal";
  const fitnessSharpness      = options.fitnessSharpness ?? 1;
  const reverseOvernightOrder = !!options.reverseOvernightOrder;
  const cpById     = new Map(controlPoints.map(cp => [cp.id, cp]));
  const taskById   = new Map(tasks.map(t => [t.id, t]));
  const courseById = new Map((courses || []).map(c => [c.id, c]));

  function routeOf(cat) {
    return courseById.get(cat.courseId)?.stops || [];
  }
  function haroilyFor(cat, taskId) {
    const baseline = courseById.get(cat.courseId)?.haroilyBaselineMin || 0;
    const extra = taskById.get(taskId)?.haroilyMin || 0;
    return baseline + extra;
  }

  const instKey = (cpId, taskId) => `${cpId}::${taskId}`;
  const instState = new Map();
  for (const cp of controlPoints) {
    for (const taskId of (cp.taskIds || [])) {
      const task = taskById.get(taskId);
      if (!task) continue;
      instState.set(instKey(cp.id, taskId), {
        cpId: cp.id,
        cpName: cp.name,
        taskId: task.id,
        taskName: task.name,
        slots: task.slots,
        unlimited:   disableQueueing || !!task.unlimitedSlots,
        slotFreeAt:  new Array(Math.max(1, task.slots | 0)).fill(-Infinity),
        waitingFIFO: [],
        arrivalsMins: [],
        depthEvents:  [],
        totalWaitMin: 0,
        maxWaitMin: 0
      });
    }
  }

  const teams = [];
  for (const cat of categories) {
    for (let i = 0; i < cat.teamCount; i++) {
      const teamNumber = i + 1;
      if ((cat.withdrawnTeamIndices || []).includes(teamNumber)) continue;
      const teamId = `${cat.id}-${teamNumber}`;
      const taskNoise = {};
      for (const t of tasks) taskNoise[t.id] = deterministicNoise(teamId, t.id);
      teams.push({
        id: teamId,
        label: `${cat.name} ${teamNumber}`,
        catId: cat.id,
        catName: cat.name,
        catColor: cat.color || null,
        stops: [],
        _cat: cat,
        _teamNumber: teamNumber,
        _fitness: teamFitness(i, cat.teamCount, fitnessCurve, fitnessSharpness),
        _taskNoise: taskNoise,
        _overnightCount: 0
      });
    }
  }

  // For every (category, route-stop) whose CP is the sleeping CP, this holds
  // the list of teamIdx values in arrival order — used to stagger morning
  // departures.
  const overnightOrders = new Map();

  let seqCounter = 0;
  const events = [];
  function schedule(time, priority, fn) {
    const ev = { time, priority, seq: seqCounter++, fn };
    let lo = 0, hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const e = events[mid];
      const cmp = (e.time - time) || (e.priority - priority) || (e.seq - ev.seq);
      if (cmp < 0) lo = mid + 1; else hi = mid;
    }
    events.splice(lo, 0, ev);
  }

  function walkMinFor(team, routeIdx) {
    if (routeIdx === 0) return 0;
    const cat = team._cat;
    const stop = routeOf(cat)[routeIdx];
    const speedMul = cat.slowestMultiplier + team._fitness * (cat.fastestMultiplier - cat.slowestMultiplier);
    const effectiveSpeed = cat.walkSpeedKmh * speedMul;
    const walkKm = stop.distanceM / 1000;
    if (walkKm <= 0 || effectiveSpeed <= 0) return 0;
    return (walkKm / effectiveSpeed) * 60;
  }

  function taskMinFor(team, task) {
    // Per-team blend between the task's slowest/fastest bounds, using the
    // same fitness factor that determines walking speed, plus a small
    // deterministic per-(team, task) perturbation controlled by the
    // category's taskVariance (defaults to 0.15). This breaks the strict
    // "fastest team is fastest at every task" correlation while keeping
    // overall fitness as the dominant signal.
    // Each category may override either bound for a specific task via
    // `cat.taskOverrides[task.id].{fastestTaskMin, slowestTaskMin}`.
    const cat = team._cat;
    const ov = cat.taskOverrides?.[task.id];
    const slow = ov?.slowestTaskMin ?? task.slowestTaskMin;
    const fast = ov?.fastestTaskMin ?? task.fastestTaskMin;
    const variance = cat.taskVariance ?? 0.15;
    let f = team._fitness + variance * team._taskNoise[task.id];
    if (f < 0) f = 0; else if (f > 1) f = 1;
    return slow + f * (fast - slow);
  }

  function pickEarliestSlot(s) {
    let idx = 0;
    for (let i = 1; i < s.slotFreeAt.length; i++) {
      if (s.slotFreeAt[i] < s.slotFreeAt[idx]) idx = i;
    }
    return idx;
  }

  // arriveAtTask: team reaches task `taskIdxInStop` at route stop `routeIdx`.
  // For a regular stop, tasks are done strictly sequentially. For a stop
  // flagged `parallel: true`, all of the stop's tasks are kicked off
  // simultaneously on the team's first arrival (taskIdxInStop === 0); the
  // team then departs the CP only once every task is finished AND its own
  // häröily has elapsed. Each task still uses its own slot pool — slow tasks
  // can still queue, and the slowest-to-be-ready task sets the team's leave
  // time.
  function arriveAtTask(teamIdx, routeIdx, taskIdxInStop, arriveMin) {
    const team = teams[teamIdx];
    const cat = team._cat;
    const stop = routeOf(cat)[routeIdx];
    const taskIds = stop.taskIds || [];
    const cp = cpById.get(stop.cpId);

    // Record overnight arrival order on the team's first arrival at this stop.
    if (taskIdxInStop === 0 && cp?.isSleepingCp) {
      const key = `${cat.id}::${routeIdx}`;
      if (!overnightOrders.has(key)) overnightOrders.set(key, []);
      const order = overnightOrders.get(key);
      if (!order.includes(teamIdx)) order.push(teamIdx);
    }

    // Parallel-tasks stop: start every task at once.
    if (taskIdxInStop === 0 && stop.parallel && taskIds.length > 0) {
      team._parallelRouteIdx = routeIdx;
      team._parallelMaxFinish = arriveMin;
      team._parallelPending = taskIds.length;
      for (let i = 0; i < taskIds.length; i++) startOrQueueSingleTask(teamIdx, routeIdx, i, arriveMin);
      return;
    }

    if (taskIdxInStop >= taskIds.length) {
      advanceToNextCp(teamIdx, routeIdx, arriveMin);
      return;
    }
    startOrQueueSingleTask(teamIdx, routeIdx, taskIdxInStop, arriveMin);
  }

  // Try to grab a slot at the given (route stop, task index). Either starts
  // the task immediately or pushes the team onto the FIFO. Stale task refs
  // skip past the task (parallel mode decrements the pending counter, with
  // no häröily since no real task ran).
  function startOrQueueSingleTask(teamIdx, routeIdx, taskIdxInStop, arriveMin) {
    const team = teams[teamIdx];
    const cat = team._cat;
    const stop = routeOf(cat)[routeIdx];
    const taskId = (stop.taskIds || [])[taskIdxInStop];
    const s = instState.get(instKey(stop.cpId, taskId));
    if (!s) {
      if (team._parallelPending != null && team._parallelRouteIdx === routeIdx) {
        decrementParallel(team, routeIdx, arriveMin, 0);
      } else {
        arriveAtTask(teamIdx, routeIdx, taskIdxInStop + 1, arriveMin);
      }
      return;
    }
    const task = taskById.get(taskId);
    const taskMin = taskMinFor(team, task);
    s.arrivalsMins.push(arriveMin);

    if (s.unlimited) {
      startTaskInstance(teamIdx, routeIdx, taskIdxInStop, arriveMin, arriveMin, taskMin, -1, s);
      return;
    }
    const slotIdx = pickEarliestSlot(s);
    const slotIsFree = s.slotFreeAt[slotIdx] <= arriveMin;
    if (slotIsFree && s.waitingFIFO.length === 0) {
      startTaskInstance(teamIdx, routeIdx, taskIdxInStop, arriveMin, arriveMin, taskMin, slotIdx, s);
    } else {
      s.waitingFIFO.push({ teamIdx, routeIdx, taskIdxInStop, arriveMin, taskMin });
      s.depthEvents.push({ time: arriveMin, delta: +1 });
    }
  }

  // eventTime is when this task-doer is physically done (raw finish, no
  // häröily); haroilyMin is that specific task's prep/pack overhead. The
  // group can only leave once every parallel task is both finished AND
  // packed up, so we track the max of (finish + häröily), not the max finish
  // and a separately-summed häröily.
  function decrementParallel(team, routeIdx, eventTime, haroilyMin = 0) {
    const departReady = eventTime + haroilyMin;
    if (departReady > team._parallelMaxFinish) team._parallelMaxFinish = departReady;
    team._parallelPending--;
    if (team._parallelPending <= 0) {
      const maxFinish = team._parallelMaxFinish;
      team._parallelPending = null;
      team._parallelMaxFinish = null;
      team._parallelRouteIdx = null;
      const teamIdx = teams.indexOf(team);
      advanceToNextCp(teamIdx, routeIdx, maxFinish);
    }
  }

  function startTaskInstance(teamIdx, routeIdx, taskIdxInStop, arriveMin, startMin, taskMin, slotIdx, s) {
    const team = teams[teamIdx];
    const cat = team._cat;
    const endMin = startMin + taskMin;
    if (slotIdx >= 0) s.slotFreeAt[slotIdx] = endMin;

    const waitMin = startMin - arriveMin;
    // Every task's leaveMin includes its own häröily now — not just the last
    // task at a CP. This is what actually delays the next task/CP too (see
    // finishTaskInstance), not merely a displayed number.
    const leaveMin = endMin + haroilyFor(cat, s.taskId);
    const walkMin = (taskIdxInStop === 0) ? walkMinFor(team, routeIdx) : 0;

    team.stops.push({
      cpId: s.cpId,
      cpName: s.cpName,
      taskId: s.taskId,
      taskName: s.taskName,
      walkMin,
      arriveMin,
      waitMin,
      startMin,
      taskMin,
      endMin,
      leaveMin
    });
    s.totalWaitMin += waitMin;
    if (waitMin > s.maxWaitMin) s.maxWaitMin = waitMin;
    schedule(endMin, FINISH, () => finishTaskInstance(teamIdx, routeIdx, taskIdxInStop, endMin, s));
  }

  function finishTaskInstance(teamIdx, routeIdx, taskIdxInStop, finishMin, s) {
    // Promote the next waiter at this task instance, if a slot is now free.
    if (!s.unlimited && s.waitingFIFO.length > 0) {
      const slotIdx = pickEarliestSlot(s);
      if (s.slotFreeAt[slotIdx] <= finishMin) {
        const w = s.waitingFIFO.shift();
        const wTask = taskById.get(s.taskId);
        const wTaskMin = taskMinFor(teams[w.teamIdx], wTask);
        s.depthEvents.push({ time: finishMin, delta: -1 });
        startTaskInstance(w.teamIdx, w.routeIdx, w.taskIdxInStop, w.arriveMin, finishMin, wTaskMin, slotIdx, s);
      }
    }

    const team = teams[teamIdx];
    const cat = team._cat;
    const stop = routeOf(cat)[routeIdx];
    const taskIds = stop.taskIds || [];
    const haroilyMin = haroilyFor(cat, s.taskId);

    // Parallel mode: just report this task's readiness; the group departs
    // once every task at the stop has done the same (see decrementParallel).
    if (team._parallelPending != null && team._parallelRouteIdx === routeIdx) {
      decrementParallel(team, routeIdx, finishMin, haroilyMin);
      return;
    }
    // Sequential mode: the next task (same CP) or the walk to the next CP
    // starts only after THIS task's häröily has elapsed — a real delay.
    if (taskIdxInStop + 1 < taskIds.length) {
      arriveAtTask(teamIdx, routeIdx, taskIdxInStop + 1, finishMin + haroilyMin);
    } else {
      advanceToNextCp(teamIdx, routeIdx, finishMin + haroilyMin);
    }
  }

  function advanceToNextCp(teamIdx, routeIdx, finishMin) {
    const team = teams[teamIdx];
    const cat = team._cat;
    const route = routeOf(cat);
    const stop = route[routeIdx];
    const nextRouteIdx = routeIdx + 1;
    if (nextRouteIdx >= route.length) return;
    const nextWalk = walkMinFor(team, nextRouteIdx);
    const cp = cpById.get(stop.cpId);
    let nextArriveMin;
    let actualDepartMin;
    if (cp?.isSleepingCp) {
      // Overnight morning: this team has now passed through one more Yörasti,
      // so it advances to the next calendar day — always restarting at the
      // same startMinutes2 clock time, whichever day this is:
      //   dayDepart = startMinutes2 + overnightCount × 1440 + (arrival order at this CP) × lähtöväli
      // A team passing through a 2nd, 3rd, ... Yörasti keeps incrementing the
      // counter, so each one adds a full further day rather than repeating
      // the same "day 2" instant. If the team's tasks (already
      // häröily-inclusive via `finishMin`) finished AFTER that scheduled
      // slot, clamp to finishMin so we don't send a team backwards in time.
      team._overnightCount++;
      const key = `${cat.id}::${routeIdx}`;
      const arrIdx = overnightOrders.get(key)?.indexOf(teamIdx) ?? 0;
      const order = reverseOvernightOrder
        ? Math.max(0, (cat.teamCount - 1) - Math.max(0, arrIdx))
        : Math.max(0, arrIdx);
      const dayDepart = cat.startMinutes2 + team._overnightCount * 1440 + order * (cat.teamStartIntervalMin || 0);
      actualDepartMin = Math.max(dayDepart, finishMin);
      nextArriveMin = actualDepartMin + nextWalk;
    } else {
      actualDepartMin = finishMin;
      nextArriveMin = finishMin + nextWalk;
    }
    // Overwrite the just-finished team's most-recent stops at this CP with
    // the *actual* leave time. In sequential mode that's only the single
    // last entry (a no-op, since it already equals actualDepartMin); in
    // parallel mode it's all N entries from this CP visit so every
    // (rasti, tehtävä) row in Kulku ennuste shows the same departure.
    const taskCount = (stop.taskIds || []).length;
    const updateCount = stop.parallel ? Math.max(1, taskCount) : 1;
    for (let k = team.stops.length - 1; k >= Math.max(0, team.stops.length - updateCount); k--) {
      if (team.stops[k].cpId === stop.cpId) team.stops[k].leaveMin = actualDepartMin;
    }
    schedule(nextArriveMin, ARRIVE, () => arriveAtTask(teamIdx, nextRouteIdx, 0, nextArriveMin));
  }

  // Seed: every team of a category starts simultaneously on day 1. The
  // Lähtöväli (teamStartIntervalMin) ONLY applies to the staggered morning
  // restart from a Yörasti — see advanceToNextCp's overnight branch.
  for (let i = 0; i < teams.length; i++) {
    const team = teams[i];
    const cat = team._cat;
    if (routeOf(cat).length === 0) continue;
    const startMin = cat.startMinutes1;
    schedule(startMin, ARRIVE, () => arriveAtTask(i, 0, 0, startMin));
  }

  while (events.length > 0) {
    const ev = events.shift();
    ev.fn();
  }

  // Aggregate leave times per task-instance AFTER the sim finishes: parallel
  // stops overwrite individual leaveMin values to the group departure time,
  // so reading team.stops post-hoc (rather than accumulating inline during
  // startTaskInstance) is the only way to get the real final leaveMin rather
  // than a pre-overwrite snapshot.
  const leaveAgg = new Map();
  for (const team of teams) {
    for (const st of team.stops) {
      const key = instKey(st.cpId, st.taskId);
      const agg = leaveAgg.get(key) || { first: Infinity, last: -Infinity };
      if (st.leaveMin < agg.first) agg.first = st.leaveMin;
      if (st.leaveMin > agg.last) agg.last = st.leaveMin;
      leaveAgg.set(key, agg);
    }
  }

  const taskStats = [];
  for (const cp of controlPoints) {
    for (const taskId of (cp.taskIds || [])) {
      const s = instState.get(instKey(cp.id, taskId));
      if (!s) continue;
      const arrivals = s.arrivalsMins;
      let peak = 0, peakAt = null;
      if (s.depthEvents.length > 0) {
        const evs = s.depthEvents.slice()
          .sort((a, b) => (a.time - b.time) || (b.delta - a.delta));
        let depth = 0;
        for (const e of evs) {
          depth += e.delta;
          if (depth > peak) { peak = depth; peakAt = e.time; }
        }
      }
      const leave = leaveAgg.get(instKey(cp.id, taskId));
      taskStats.push({
        cpId: s.cpId,
        cpName: s.cpName,
        taskId: s.taskId,
        taskName: s.taskName,
        slots: s.slots,
        unlimitedSlots: s.unlimited,
        arrivalCount: arrivals.length,
        firstArrivalMin: arrivals.length ? Math.min(...arrivals) : null,
        lastArrivalMin:  arrivals.length ? Math.max(...arrivals) : null,
        firstLeaveMin: leave ? leave.first : null,
        lastLeaveMin:  leave ? leave.last  : null,
        peakWaiting: peak,
        peakAtMin: peakAt,
        totalWaitMin: s.totalWaitMin,
        worstWaitMin: s.maxWaitMin
      });
    }
  }

  const cleanTeams = teams.map(t => ({
    id: t.id,
    label: t.label,
    catId: t.catId,
    catName: t.catName,
    catColor: t.catColor,
    stops: t.stops
  }));

  return { teams: cleanTeams, taskStats };
}
