// Small state-lookup helpers shared by views. Take `state` explicitly (not a
// fixed singleton) since state.js re-assigns its internal object on every
// setState(), so views must always look up against a freshly-read getState().
export function findTask(state, id) { return state.tasks.find(t => t.id === id); }
export function findCp(state, id) { return state.controlPoints.find(c => c.id === id); }
export function findCourse(state, id) { return state.courses.find(c => c.id === id); }
export function coursesUsedBy(state, courseId) { return state.categories.filter(c => c.courseId === courseId); }
