import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateRace, teamFitness, teamSpeedMultiplier } from "../js/model/simulate.js";

// CPs with task assignments. isSleepingCp defaults to falsy (undefined) here;
// tests that need an overnight restart set it explicitly on one CP.
const cps = [
  { id: "A", name: "Lähtö", taskIds: ["tA"] },
  { id: "B", name: "Museo", taskIds: ["tB"] },
  { id: "C", name: "Maali", taskIds: ["tC"] }
];

// Every task has equal fastest/slowest so single-team scenarios are stable,
// and häröilyMin defaults to 0 unless a test needs it.
function baseTasks(overrides = {}) {
  return [
    { id: "tA", name: "Start", slots: 99, unlimitedSlots: true, fastestTaskMin: 10, slowestTaskMin: 10, haroilyMin: 0 },
    { id: "tB", name: "Mid",   slots: 2,  unlimitedSlots: false, fastestTaskMin: 20, slowestTaskMin: 20, haroilyMin: 0 },
    { id: "tC", name: "End",   slots: 99, unlimitedSlots: true, fastestTaskMin: 0,  slowestTaskMin: 0,  haroilyMin: 0 },
    ...(overrides.extra || [])
  ];
}

// A course is the reusable route template — stops now carry `parallel`
// instead of the CP carrying it, and there is no `overnight` flag (derived
// from controlPoints[].isSleepingCp instead).
function baseCourse(overrides = {}) {
  return {
    id: "courseX",
    name: "Course",
    haroilyBaselineMin: 0,
    stops: [
      { cpId: "A", distanceM: 0,    taskIds: ["tA"], parallel: false },
      { cpId: "B", distanceM: 1000, taskIds: ["tB"], parallel: false },
      { cpId: "C", distanceM: 500,  taskIds: ["tC"], parallel: false }
    ],
    ...overrides
  };
}

function baseCat(overrides = {}) {
  return {
    id: "cat1",
    name: "Test",
    color: "#fff",
    walkSpeedKmh: 6.0,        // 1 km = 10 min walk
    fastestMultiplier: 1.0,
    slowestMultiplier: 1.0,
    taskVariance: 0,          // off so existing assertions stay deterministic
    courseId: "courseX",
    startMinutes1: 600,       // 10:00
    startMinutes2: 0,
    teamCount: 1,
    teamStartIntervalMin: 5,
    withdrawnTeamIndices: [],
    ...overrides
  };
}

test("single team: walk + task arithmetic, no queueing, no häröily", () => {
  const { teams } = simulateRace(cps, baseTasks(), [baseCourse()], [baseCat()]);
  assert.equal(teams.length, 1);
  const t = teams[0];
  assert.equal(t.stops[0].arriveMin, 600);
  assert.equal(t.stops[0].waitMin, 0);
  assert.equal(t.stops[0].leaveMin, 610);
  assert.equal(t.stops[1].arriveMin, 620);
  assert.equal(t.stops[1].leaveMin, 640);
  assert.equal(t.stops[2].arriveMin, 645);
});

test("speed multipliers act on speed directly: mul=2 → walks twice as fast", () => {
  const cat = baseCat({ slowestMultiplier: 2.0, fastestMultiplier: 2.0 });
  const { teams } = simulateRace(cps, baseTasks(), [baseCourse()], [cat]);
  const t = teams[0];
  assert.equal(t.stops[1].arriveMin, 615);   // 600 + task 10 + walk 5
  assert.equal(t.stops[2].arriveMin, 637.5); // 615 + task 20 + walk 2.5
});

test("speed multipliers act on speed directly: mul=0.5 → walks half as fast", () => {
  const cat = baseCat({ slowestMultiplier: 0.5, fastestMultiplier: 0.5 });
  const { teams } = simulateRace(cps, baseTasks(), [baseCourse()], [cat]);
  const t = teams[0];
  assert.equal(t.stops[1].arriveMin, 630);  // 600 + task 10 + walk 20
});

test("task time blends per team between slowestTaskMin and fastestTaskMin", () => {
  const tasks = [
    { id: "tA", name: "Start", slots: 99, unlimitedSlots: true, fastestTaskMin: 0,  slowestTaskMin: 0,  haroilyMin: 0 },
    { id: "tB", name: "Mid",   slots: 99, unlimitedSlots: true, fastestTaskMin: 20, slowestTaskMin: 30, haroilyMin: 0 },
    { id: "tC", name: "End",   slots: 99, unlimitedSlots: true, fastestTaskMin: 0,  slowestTaskMin: 0,  haroilyMin: 0 }
  ];
  const single = simulateRace(cps, tasks, [baseCourse()], [baseCat({ teamCount: 1 })]).teams[0];
  assert.equal(single.stops[1].endMin - single.stops[1].startMin, 25);
  const ten = simulateRace(cps, tasks, [baseCourse()], [baseCat({ teamCount: 10, teamStartIntervalMin: 0 })]).teams;
  const taskTimes = ten.map(t => t.stops[1].endMin - t.stops[1].startMin).sort((a, b) => a - b);
  assert.ok(Math.abs(taskTimes[0] - 20) < 0.01);
  assert.ok(Math.abs(taskTimes[9] - 30) < 0.01);
});

test("per-category taskOverrides override the task's default fastest/slowest bounds", () => {
  const tasks = [
    { id: "tA", name: "Start", slots: 99, unlimitedSlots: true, fastestTaskMin: 0,  slowestTaskMin: 0,  haroilyMin: 0 },
    { id: "tB", name: "Mid",   slots: 99, unlimitedSlots: true, fastestTaskMin: 20, slowestTaskMin: 30, haroilyMin: 0 },
    { id: "tC", name: "End",   slots: 99, unlimitedSlots: true, fastestTaskMin: 0,  slowestTaskMin: 0,  haroilyMin: 0 }
  ];
  const catA = baseCat({ id: "catA", name: "A", teamCount: 1 });
  const catB = baseCat({ id: "catB", name: "B", teamCount: 1 });
  catB.taskOverrides = { tB: { fastestTaskMin: 60, slowestTaskMin: 60 } };
  const catC = baseCat({ id: "catC", name: "C", teamCount: 1 });
  catC.taskOverrides = { tB: { slowestTaskMin: 90 } };
  const { teams } = simulateRace(cps, tasks, [baseCourse()], [catA, catB, catC]);
  const taskTime = id => {
    const t = teams.find(x => x.catId === id);
    return t.stops[1].endMin - t.stops[1].startMin;
  };
  assert.equal(taskTime("catA"), 25);
  assert.equal(taskTime("catB"), 60);
  assert.equal(taskTime("catC"), 55);
});

test("taskVariance perturbs task times deterministically and the fastest team isn't always the fastest", () => {
  const tasks = [
    { id: "tA", name: "Start", slots: 99, unlimitedSlots: true, fastestTaskMin: 0,  slowestTaskMin: 0,   haroilyMin: 0 },
    { id: "tB", name: "Mid",   slots: 99, unlimitedSlots: true, fastestTaskMin: 0,  slowestTaskMin: 100, haroilyMin: 0 },
    { id: "tC", name: "End",   slots: 99, unlimitedSlots: true, fastestTaskMin: 0,  slowestTaskMin: 0,   haroilyMin: 0 }
  ];
  const cat = baseCat({ teamCount: 10, teamStartIntervalMin: 0, taskVariance: 0.4 });
  const run1 = simulateRace(cps, tasks, [baseCourse()], [cat]).teams;
  const run2 = simulateRace(cps, tasks, [baseCourse()], [cat]).teams;
  for (let i = 0; i < run1.length; i++) {
    assert.equal(run1[i].stops[1].endMin, run2[i].stops[1].endMin, `team ${i} not deterministic`);
  }
  const taskTimes = run1.map((t, i) => ({ idx: i, time: t.stops[1].endMin - t.stops[1].startMin }));
  taskTimes.sort((a, b) => a.time - b.time);
  assert.notEqual(taskTimes[0].idx, 9, "with taskVariance > 0 the global-fastest team should not always be the per-task fastest");
});

test("teams' speeds spread between slowest and fastest multipliers on a normal curve", () => {
  const tasksZero = [
    { id: "tA", name: "S", slots: 99, unlimitedSlots: true, fastestTaskMin: 0, slowestTaskMin: 0, haroilyMin: 0 },
    { id: "tB", name: "M", slots: 99, unlimitedSlots: true, fastestTaskMin: 0, slowestTaskMin: 0, haroilyMin: 0 },
    { id: "tC", name: "E", slots: 99, unlimitedSlots: true, fastestTaskMin: 0, slowestTaskMin: 0, haroilyMin: 0 }
  ];
  const cat = baseCat({ teamCount: 10, teamStartIntervalMin: 0, slowestMultiplier: 0.5, fastestMultiplier: 2.0 });
  const { teams } = simulateRace(cps, tasksZero, [baseCourse()], [cat]);
  const walks = teams.map(t => t.stops[1].arriveMin - t.stops[0].arriveMin).sort((a, b) => a - b);
  assert.ok(Math.abs(walks[0] - 5)  < 0.01, `fastest team's walk should be ~5 min, got ${walks[0]}`);
  assert.ok(Math.abs(walks[9] - 20) < 0.01, `slowest team's walk should be ~20 min, got ${walks[9]}`);
  const med = (walks[4] + walks[5]) / 2;
  assert.ok(med > 6 && med < 14, `median walk should be between 6 and 14 min, got ${med}`);
});

test("teamSpeedMultiplier helper: monotonic and hits endpoints exactly", () => {
  assert.equal(teamSpeedMultiplier(0, 1, 0.5, 2.0), 1.25);
  assert.ok(Math.abs(teamSpeedMultiplier(0, 10, 0.5, 2.0) - 0.5) < 1e-9);
  assert.ok(Math.abs(teamSpeedMultiplier(9, 10, 0.5, 2.0) - 2.0) < 1e-9);
  let prev = -Infinity;
  for (let i = 0; i < 10; i++) {
    const m = teamSpeedMultiplier(i, 10, 0.5, 2.0);
    assert.ok(m > prev, `not monotonic at i=${i}: ${m} <= ${prev}`);
    prev = m;
  }
});

test("options.fitnessCurve = 'linear': teams are evenly spaced 0..1, no bell clustering", () => {
  for (let i = 0; i < 10; i++) {
    const f = teamFitness(i, 10, "linear");
    const expected = i / 9;
    assert.ok(Math.abs(f - expected) < 1e-9, `linear i=${i}: ${f} vs ${expected}`);
  }
  const middleNormal = teamFitness(4, 10);
  const middleLinear = teamFitness(4, 10, "linear");
  assert.notEqual(middleNormal.toFixed(4), middleLinear.toFixed(4));
});

test("fitness 'normal' with higher sharpness clusters middle teams more tightly", () => {
  const mid1 = teamFitness(4, 10, "normal", 1);
  const mid3 = teamFitness(4, 10, "normal", 3);
  assert.equal(teamFitness(0, 10, "normal", 3), 0);
  assert.equal(teamFitness(9, 10, "normal", 3), 1);
  assert.ok(Math.abs(mid3 - 0.5) < Math.abs(mid1 - 0.5),
    `team 4 at sharpness=3 should be closer to 0.5: |${mid3}-0.5| < |${mid1}-0.5|`);
});

test("fitness 'power': sharpness IS the exponent on the linear position", () => {
  for (let i = 0; i < 10; i++) {
    assert.ok(Math.abs(teamFitness(i, 10, "power", 1) - i / 9) < 1e-9);
  }
  for (let i = 0; i < 10; i++) {
    const expected = Math.pow(i / 9, 2);
    const got = teamFitness(i, 10, "power", 2);
    assert.ok(Math.abs(got - expected) < 1e-9, `i=${i}: ${got} vs ${expected}`);
  }
  assert.equal(teamFitness(0, 10, "power", 2), 0);
  assert.equal(teamFitness(9, 10, "power", 2), 1);
});

test("options.disableQueueing: every task is treated as Rajaton so no team ever waits", () => {
  const cat = baseCat({ teamCount: 3 });
  const { teams, taskStats } = simulateRace(cps, baseTasks(), [baseCourse()], [cat], { disableQueueing: true });
  for (const t of teams) for (const s of t.stops) assert.equal(s.waitMin, 0);
  const sB = taskStats.find(s => s.cpId === "B" && s.taskId === "tB");
  assert.equal(sB.peakWaiting, 0);
});

test("unlimitedSlots: no team ever waits, regardless of how many arrive simultaneously", () => {
  const cpsX = [
    { id: "A", name: "Lähtö", taskIds: ["tA"] },
    { id: "B", name: "Avoin", taskIds: ["tBopen"] },
    { id: "C", name: "Maali", taskIds: ["tC"] }
  ];
  const tasksX = [
    { id: "tA",     name: "Start", slots: 99, unlimitedSlots: true, fastestTaskMin: 0,  slowestTaskMin: 0,  haroilyMin: 0 },
    { id: "tBopen", name: "Avoin", slots: 1,  unlimitedSlots: true, fastestTaskMin: 30, slowestTaskMin: 30, haroilyMin: 0 },
    { id: "tC",     name: "End",   slots: 99, unlimitedSlots: true, fastestTaskMin: 0,  slowestTaskMin: 0,  haroilyMin: 0 }
  ];
  const courseX = baseCourse({
    stops: [
      { cpId: "A", distanceM: 0,    taskIds: ["tA"],     parallel: false },
      { cpId: "B", distanceM: 1000, taskIds: ["tBopen"], parallel: false },
      { cpId: "C", distanceM: 0,    taskIds: ["tC"],     parallel: false }
    ]
  });
  const cat = baseCat({ teamCount: 5, teamStartIntervalMin: 1 });
  const { teams, taskStats } = simulateRace(cpsX, tasksX, [courseX], [cat]);
  for (const t of teams) {
    assert.equal(t.stops[1].waitMin, 0);
    assert.equal(t.stops[1].startMin, t.stops[1].arriveMin);
    assert.equal(t.stops[1].endMin, t.stops[1].arriveMin + 30);
  }
  const sB = taskStats.find(s => s.cpId === "B" && s.taskId === "tBopen");
  assert.equal(sB.peakWaiting, 0);
  assert.equal(sB.totalWaitMin, 0);
  assert.equal(sB.unlimitedSlots, true);
});

test("queue propagation: 3 teams through 2-slot task, third waits and delay cascades to C", () => {
  const cat = baseCat({ teamCount: 3 });
  const { teams, taskStats } = simulateRace(cps, baseTasks(), [baseCourse()], [cat]);
  assert.equal(teams[0].stops[1].waitMin, 0);
  assert.equal(teams[1].stops[1].waitMin, 0);
  assert.equal(teams[2].stops[1].arriveMin, 620);
  assert.equal(teams[2].stops[1].startMin, 640);
  assert.equal(teams[2].stops[1].waitMin, 20);
  assert.equal(teams[2].stops[1].endMin, 660);
  assert.equal(teams[2].stops[2].arriveMin, 665);
  const sB = taskStats.find(s => s.cpId === "B" && s.taskId === "tB");
  assert.equal(sB.peakWaiting, 1);
  assert.equal(sB.peakAtMin, 620);
  assert.equal(sB.arrivalCount, 3);
  assert.equal(sB.firstArrivalMin, 620);
  assert.equal(sB.lastArrivalMin, 620);
});

test("course shared by two categories: both reference the same courseId, slots still shared", () => {
  const tasksTight = [
    { id: "tA", name: "Start", slots: 99, unlimitedSlots: true, fastestTaskMin: 10, slowestTaskMin: 10, haroilyMin: 0 },
    { id: "tB", name: "Bottleneck", slots: 1, unlimitedSlots: false, fastestTaskMin: 20, slowestTaskMin: 20, haroilyMin: 0 },
    { id: "tC", name: "End", slots: 99, unlimitedSlots: true, fastestTaskMin: 0, slowestTaskMin: 0, haroilyMin: 0 }
  ];
  const catA = baseCat({ id: "catA", name: "A", teamCount: 1, startMinutes1: 600 });
  const catB = baseCat({ id: "catB", name: "B", teamCount: 1, startMinutes1: 605 });
  const { teams, taskStats } = simulateRace(cps, tasksTight, [baseCourse()], [catA, catB]);
  const tA = teams.find(t => t.catId === "catA");
  const tB = teams.find(t => t.catId === "catB");
  // Both categories reference the SAME course object, demonstrating reuse.
  assert.equal(catA.courseId, catB.courseId);
  assert.equal(tA.stops[1].startMin, 620);
  assert.equal(tA.stops[1].endMin, 640);
  assert.equal(tB.stops[1].arriveMin, 625);
  assert.equal(tB.stops[1].waitMin, 15);
  assert.equal(tB.stops[1].startMin, 640);
  assert.equal(tB.stops[2].arriveMin, 665);
  const sB = taskStats.find(s => s.cpId === "B" && s.taskId === "tB");
  assert.equal(sB.peakWaiting, 1);
  assert.equal(sB.peakAtMin, 625);
});

test("taskStats arrivalCount/firstArrivalMin/lastArrivalMin span all teams", () => {
  const cat = baseCat({ teamCount: 4, teamStartIntervalMin: 5 });
  const { taskStats } = simulateRace(cps, baseTasks(), [baseCourse()], [cat]);
  const sA = taskStats.find(s => s.cpId === "A");
  assert.equal(sA.arrivalCount, 4);
  // Day-1 start is always simultaneous regardless of teamStartIntervalMin.
  assert.equal(sA.firstArrivalMin, 600);
  assert.equal(sA.lastArrivalMin, 600);
});

// --- v2-specific behavior ---------------------------------------------

test("häröilyaika = course baseline + task addition, applied after EVERY task, and really delays the next one", () => {
  const cpsM = [
    { id: "A", name: "Lähtö", taskIds: ["tA"] },
    { id: "M", name: "Multi", taskIds: ["t1", "t2"] },
    { id: "C", name: "Maali", taskIds: ["tC"] }
  ];
  const tasksM = [
    { id: "tA", name: "Start", slots: 99, unlimitedSlots: true, fastestTaskMin: 0,  slowestTaskMin: 0,  haroilyMin: 0 },
    { id: "t1", name: "T1",    slots: 99, unlimitedSlots: true, fastestTaskMin: 10, slowestTaskMin: 10, haroilyMin: 2 },
    { id: "t2", name: "T2",    slots: 99, unlimitedSlots: true, fastestTaskMin: 5,  slowestTaskMin: 5,  haroilyMin: 0 },
    { id: "tC", name: "End",   slots: 99, unlimitedSlots: true, fastestTaskMin: 0,  slowestTaskMin: 0,  haroilyMin: 0 }
  ];
  const courseM = baseCourse({
    haroilyBaselineMin: 3,
    stops: [
      { cpId: "A", distanceM: 0, taskIds: ["tA"],       parallel: false },
      { cpId: "M", distanceM: 0, taskIds: ["t1", "t2"], parallel: false },
      { cpId: "C", distanceM: 0, taskIds: ["tC"],       parallel: false }
    ]
  });
  const cat = baseCat();
  const { teams } = simulateRace(cpsM, tasksM, [courseM], [cat]);
  const t = teams[0];
  assert.equal(t.stops.length, 4); // tA, t1, t2, tC

  // tA: 0-duration, häröily = baseline(3) + tA.haroilyMin(0) = 3.
  assert.equal(t.stops[0].endMin, 600);
  assert.equal(t.stops[0].leaveMin, 603);

  // t1: arrives at tA's leave (603, no walk — distanceM 0). Task 10 → end 613.
  // häröily = baseline(3) + t1.haroilyMin(2) = 5 → leave 618.
  assert.equal(t.stops[1].arriveMin, 603);
  assert.equal(t.stops[1].endMin, 613);
  assert.equal(t.stops[1].leaveMin, 618);

  // t2 (same CP, sequential): arrives at t1's leave time, 618 — NOT at t1's
  // raw end (613). This is the real-delay assertion: häröily must actually
  // push the next task's start, not just annotate a displayed number.
  assert.equal(t.stops[2].arriveMin, 618);
  // Task 5 → end 623. häröily = baseline(3) + t2.haroilyMin(0) = 3 → leave 626.
  assert.equal(t.stops[2].endMin, 623);
  assert.equal(t.stops[2].leaveMin, 626);

  // tC: arrives at t2's leave time (626, no walk).
  assert.equal(t.stops[3].arriveMin, 626);
});

test("häröilyaika never holds the task's own slot — a second team can start the instant the first team's raw task ends", () => {
  const cpsM = [
    { id: "A", name: "Lähtö", taskIds: ["tA"] },
    { id: "B", name: "B", taskIds: ["tB"] }
  ];
  const tasksM = [
    { id: "tA", name: "S", slots: 99, unlimitedSlots: true, fastestTaskMin: 0, slowestTaskMin: 0, haroilyMin: 0 },
    { id: "tB", name: "B", slots: 1,  unlimitedSlots: false, fastestTaskMin: 10, slowestTaskMin: 10, haroilyMin: 50 }
  ];
  const courseM = baseCourse({
    haroilyBaselineMin: 0,
    stops: [
      { cpId: "A", distanceM: 0, taskIds: ["tA"], parallel: false },
      { cpId: "B", distanceM: 0, taskIds: ["tB"], parallel: false }
    ]
  });
  const cat = baseCat({ teamCount: 2, teamStartIntervalMin: 0 });
  const { teams } = simulateRace(cpsM, tasksM, [courseM], [cat]);
  // Both teams start tA at 600, arrive B at 600 simultaneously. Team order in
  // the slot queue is stable (index order): team 0 gets the slot, team 1 waits.
  const t0 = teams[0], t1 = teams[1];
  assert.equal(t0.stops[1].startMin, 600);
  assert.equal(t0.stops[1].endMin, 610);        // slot occupied 600–610 only
  // Team 1 must be able to start the instant the raw task ends (610), NOT
  // wait for team 0's 50-min häröily to finish — the slot frees at 610.
  assert.equal(t1.stops[1].startMin, 610);
  assert.equal(t1.stops[1].waitMin, 10);
});

test("per-stop parallel: team departs once every task is finished AND its own häröily has elapsed (max, not sum)", () => {
  const cpsP = [
    { id: "A", name: "S", taskIds: ["tA"] },
    { id: "M", name: "Multi", taskIds: ["t1", "t2", "t3"] },
    { id: "C", name: "F", taskIds: ["tC"] }
  ];
  const tasksP = [
    { id: "tA", name: "S",  slots: 99, unlimitedSlots: true, fastestTaskMin: 0,  slowestTaskMin: 0,  haroilyMin: 0 },
    { id: "t1", name: "T1", slots: 99, unlimitedSlots: true, fastestTaskMin: 10, slowestTaskMin: 10, haroilyMin: 0 },
    { id: "t2", name: "T2", slots: 99, unlimitedSlots: true, fastestTaskMin: 15, slowestTaskMin: 15, haroilyMin: 5 },
    { id: "t3", name: "T3", slots: 99, unlimitedSlots: true, fastestTaskMin: 5,  slowestTaskMin: 5,  haroilyMin: 0 },
    { id: "tC", name: "F",  slots: 99, unlimitedSlots: true, fastestTaskMin: 0,  slowestTaskMin: 0,  haroilyMin: 0 }
  ];
  const courseP = baseCourse({
    haroilyBaselineMin: 0,
    stops: [
      { cpId: "A", distanceM: 0, taskIds: ["tA"],             parallel: false },
      { cpId: "M", distanceM: 0, taskIds: ["t1", "t2", "t3"], parallel: true },
      { cpId: "C", distanceM: 0, taskIds: ["tC"],             parallel: false }
    ]
  });
  const cat = baseCat({ teamCount: 1 });
  const { teams } = simulateRace(cpsP, tasksP, [courseP], [cat]);
  const t = teams[0];
  assert.equal(t.stops[1].startMin, 600);
  assert.equal(t.stops[2].startMin, 600);
  assert.equal(t.stops[3].startMin, 600);
  assert.equal(t.stops[1].endMin, 610); // t1, no häröily → ready at 610
  assert.equal(t.stops[2].endMin, 615); // t2 ends 615, +5 häröily → ready 620
  assert.equal(t.stops[3].endMin, 605); // t3, no häröily → ready at 605
  // t2's (end + häröily) = 620 beats t1's raw 610 — group waits for it, not
  // for whichever task finished last numerically.
  assert.equal(t.stops[4].arriveMin, 620);
  assert.equal(t.stops[1].leaveMin, 620);
  assert.equal(t.stops[2].leaveMin, 620);
  assert.equal(t.stops[3].leaveMin, 620);
});

test("overnight is derived from controlPoints[].isSleepingCp, not a per-stop flag", () => {
  const cpsO = [
    { id: "A", name: "Lähtö", taskIds: ["tA"] },
    { id: "B", name: "Yö", taskIds: ["tB"], isSleepingCp: true },
    { id: "C", name: "Maali", taskIds: ["tC"] }
  ];
  const cat = baseCat({ startMinutes2: 540 });
  const { teams } = simulateRace(cpsO, baseTasks(), [baseCourse()], [cat]);
  // Day-2 morning anchor = 540 + 1440 = 1980. Walk B→C = 500 m / 6 km/h = 5 min.
  assert.equal(teams[0].stops[2].arriveMin, 1985);
});

test("overnight: day-2 departures are staggered in arrival order at the sleeping CP", () => {
  const cpsO = [
    { id: "A", name: "Lähtö", taskIds: ["tA"] },
    { id: "B", name: "Yö", taskIds: ["tB"], isSleepingCp: true },
    { id: "C", name: "Maali", taskIds: ["tC"] }
  ];
  const cat = baseCat({ teamCount: 3, teamStartIntervalMin: 5, startMinutes2: 540 });
  const { teams } = simulateRace(cpsO, baseTasks(), [baseCourse()], [cat]);
  assert.equal(teams[0].stops[2].arriveMin, 1985);   // 1980 + 0 + 5
  assert.equal(teams[1].stops[2].arriveMin, 1990);   // 1980 + 5 + 5
  assert.equal(teams[2].stops[2].arriveMin, 1995);   // 1980 + 10 + 5
});

test("overnight + reverseOvernightOrder: last arrival at the sleeping CP is first to leave next morning", () => {
  const cpsO = [
    { id: "A", name: "Lähtö", taskIds: ["tA"] },
    { id: "B", name: "Yö", taskIds: ["tB"], isSleepingCp: true },
    { id: "C", name: "Maali", taskIds: ["tC"] }
  ];
  const cat = baseCat({ teamCount: 3, teamStartIntervalMin: 5, startMinutes2: 540 });
  const { teams } = simulateRace(cpsO, baseTasks(), [baseCourse()], [cat], { reverseOvernightOrder: true });
  assert.equal(teams[2].stops[2].arriveMin, 1985);
  assert.equal(teams[1].stops[2].arriveMin, 1990);
  assert.equal(teams[0].stops[2].arriveMin, 1995);
});

test("multi-day: two Yörasti CPs in sequence each add a full further day, not a repeat of day 2", () => {
  const cpsMulti = [
    { id: "A", name: "Lähtö", taskIds: ["tA"] },
    { id: "B", name: "Yö1", taskIds: ["tB"], isSleepingCp: true },
    { id: "C", name: "Yö2", taskIds: ["tC"], isSleepingCp: true },
    { id: "D", name: "Maali", taskIds: ["tD"] }
  ];
  const zeroTask = id => ({ id, name: id, slots: 99, unlimitedSlots: true, fastestTaskMin: 0, slowestTaskMin: 0, haroilyMin: 0 });
  const tasksMulti = [zeroTask("tA"), zeroTask("tB"), zeroTask("tC"), zeroTask("tD")];
  const course = baseCourse({
    haroilyBaselineMin: 0,
    stops: [
      { cpId: "A", distanceM: 0,   taskIds: ["tA"], parallel: false },
      { cpId: "B", distanceM: 0,   taskIds: ["tB"], parallel: false },
      { cpId: "C", distanceM: 0,   taskIds: ["tC"], parallel: false },
      { cpId: "D", distanceM: 500, taskIds: ["tD"], parallel: false }
    ]
  });
  const cat = baseCat({ teamCount: 2, teamStartIntervalMin: 5, startMinutes2: 540 });
  const { teams } = simulateRace(cpsMulti, tasksMulti, [course], [cat]);
  // Both teams start day 1 simultaneously, so both reach Yö1 (B) at once —
  // arrival order [team0, team1]. 1st overnight: startMinutes2 + 1*1440.
  assert.equal(teams[0].stops[1].leaveMin, 540 + 1440);       // 1980, order 0
  assert.equal(teams[1].stops[1].leaveMin, 540 + 1440 + 5);   // 1985, order 1
  // B→C has 0 distance, so arrival at Yö2 (C) mirrors the leave order from B:
  // team0 (1980) arrives before team1 (1985) — a fresh, independent order.
  // 2nd overnight: startMinutes2 + 2*1440 — NOT a repeat of +1*1440, which
  // is the exact regression a single-day-only formula would produce (it
  // would already be in the past by now and get clamped to finishMin).
  assert.equal(teams[0].stops[2].leaveMin, 540 + 2 * 1440);       // 3420, order 0
  assert.equal(teams[1].stops[2].leaveMin, 540 + 2 * 1440 + 5);   // 3425, order 1
  // Final leg: walk 500m at 6 km/h = 5 min from each team's actual leave time.
  assert.equal(teams[0].stops[3].arriveMin, 540 + 2 * 1440 + 5);       // 3425
  assert.equal(teams[1].stops[3].arriveMin, 540 + 2 * 1440 + 5 + 5);   // 3430
});

test("withdrawnTeamIndices (DNS/DNF): those team numbers are absent from teams[] and taskStats", () => {
  const cat = baseCat({ teamCount: 3, withdrawnTeamIndices: [2] });
  const { teams, taskStats } = simulateRace(cps, baseTasks(), [baseCourse()], [cat]);
  assert.equal(teams.length, 2);
  assert.deepEqual(teams.map(t => t.id).sort(), ["cat1-1", "cat1-3"]);
  assert.deepEqual(teams.map(t => t.label).sort(), ["Test 1", "Test 3"]);
  const sB = taskStats.find(s => s.cpId === "B" && s.taskId === "tB");
  assert.equal(sB.arrivalCount, 2);
});

test("withdrawing a team does not shift the fitness/pace of the remaining teams", () => {
  // Team 2 (of 10) withdraws. The remaining teams' task times must match a
  // run WITHOUT withdrawal at the same index — fitness is positional, not
  // renumbered after a withdrawal.
  const tasks = [
    { id: "tA", name: "S", slots: 99, unlimitedSlots: true, fastestTaskMin: 0,  slowestTaskMin: 0,   haroilyMin: 0 },
    { id: "tB", name: "M", slots: 99, unlimitedSlots: true, fastestTaskMin: 0,  slowestTaskMin: 100, haroilyMin: 0 },
    { id: "tC", name: "E", slots: 99, unlimitedSlots: true, fastestTaskMin: 0,  slowestTaskMin: 0,   haroilyMin: 0 }
  ];
  const full = simulateRace(cps, tasks, [baseCourse()], [baseCat({ teamCount: 10, teamStartIntervalMin: 0 })]).teams;
  const withdrawn = simulateRace(cps, tasks, [baseCourse()], [baseCat({ teamCount: 10, teamStartIntervalMin: 0, withdrawnTeamIndices: [2] })]).teams;
  const team9Full = full.find(t => t.id === "cat1-9");
  const team9Withdrawn = withdrawn.find(t => t.id === "cat1-9");
  assert.equal(team9Full.stops[1].endMin, team9Withdrawn.stops[1].endMin);
});

test("taskStats: worstWaitMin, firstLeaveMin, lastLeaveMin are populated correctly", () => {
  const tasksBottleneck = [
    { id: "tA", name: "S", slots: 99, unlimitedSlots: true, fastestTaskMin: 10, slowestTaskMin: 10, haroilyMin: 0 },
    { id: "tB", name: "B", slots: 2,  unlimitedSlots: false, fastestTaskMin: 20, slowestTaskMin: 20, haroilyMin: 1 },
    { id: "tC", name: "E", slots: 99, unlimitedSlots: true, fastestTaskMin: 0,  slowestTaskMin: 0,  haroilyMin: 0 }
  ];
  const course = baseCourse({ haroilyBaselineMin: 2 });
  const cat = baseCat({ teamCount: 3 });
  const { taskStats } = simulateRace(cps, tasksBottleneck, [course], [cat]);
  const sB = taskStats.find(s => s.cpId === "B" && s.taskId === "tB");
  // tA: end 610, häröily = 2+0 = 2 → leave 612. Walk 1000m/6km/h = 10min →
  // all 3 teams arrive B simultaneously at 622 (day-1 start is simultaneous).
  // 2 slots: teams 0/1 start immediately (wait 0), team 2 waits 20 (slot
  // frees at 642).
  assert.equal(sB.worstWaitMin, 20);
  // häröily at B = baseline(2) + tB.haroilyMin(1) = 3.
  // team0/1: end 642, leave 645. team2: end 662, leave 665.
  assert.equal(sB.firstLeaveMin, 645);
  assert.equal(sB.lastLeaveMin, 665);
});

test("a stop with no tasks (e.g. taskIds: []) produces no team.stops entry there, just passes through", () => {
  const cpsEmpty = [
    { id: "A", name: "Lähtö", taskIds: [] },
    { id: "B", name: "B", taskIds: ["tB"] },
    { id: "C", name: "Maali", taskIds: [] }
  ];
  const tasksEmpty = [
    { id: "tB", name: "B", slots: 99, unlimitedSlots: true, fastestTaskMin: 5, slowestTaskMin: 5, haroilyMin: 0 }
  ];
  const course = baseCourse({
    haroilyBaselineMin: 0,
    stops: [
      { cpId: "A", distanceM: 0,    taskIds: [],     parallel: false },
      { cpId: "B", distanceM: 1000, taskIds: ["tB"], parallel: false },
      { cpId: "C", distanceM: 500,  taskIds: [],     parallel: false }
    ]
  });
  const cat = baseCat();
  const { teams } = simulateRace(cpsEmpty, tasksEmpty, [course], [cat]);
  // Only the B visit produces a stop entry — A and C have no tasks assigned.
  // This is why state.js seeds LÄHTÖ/MAALI with trivial marker tasks instead
  // of leaving taskIds empty (see js/state.js's DEFAULT_TASKS comment).
  assert.equal(teams[0].stops.length, 1);
  assert.equal(teams[0].stops[0].cpId, "B");
  assert.equal(teams[0].stops[0].arriveMin, 610); // 600 + walk 1000m/6km/h=10
});
