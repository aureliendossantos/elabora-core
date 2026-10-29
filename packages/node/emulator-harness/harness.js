// Fake LMS page: scorm-again's Scorm12API configured from an executable profile, plus the quirks
// that profiles document (suspend_data limit and enforcement, mastery override, launch topology).
// Shown in a frame (the desktop app's Aperçu), it tells that page what the LMS receives and what the
// course does, and sets a variable when asked: messages { type: 'elabora/lms', kind, … } to the
// parent (session, call, course, state, events; docs/delivery-scorm12.md), and
// { type: 'elabora/lms-ask', ask: 'set-variable', id, value } from it.
(async function () {
  const q = new URLSearchParams(location.search);
  const pkg = q.get('pkg');
  const reg = q.get('reg') || 'reg-1';
  const mode = q.get('mode') || 'iframe';
  const mastery = q.get('mastery');
  const profile = await fetch(`/lms/profile/${q.get('profile') || 'unknown'}`).then((r) => r.json());
  const saved = await fetch(`/lms/state/${reg}`).then((r) => r.json());
  const limit = profile.datamodel?.suspendDataMax?.scorm12 ?? 4096;
  const enforcement = profile.datamodel?.suspendDataEnforcement || 'reject';
  const autocommit = profile.harness?.autocommitSeconds || 0;
  const parent = window.parent !== window ? window.parent : null;
  const tell = (message) => { if (parent) parent.postMessage({ type: 'elabora/lms', ...message }, '*'); };

  const api = new window.Scorm12API({
    lmsCommitUrl: `/lms/commit/${reg}`,
    autocommit: autocommit > 0,
    autocommitSeconds: autocommit || 60,
    dataCommitFormat: 'json',
    useAsynchronousCommits: profile.harness?.syncCommits === false,
    asyncModeBeaconBehavior: 'never',
    mastery_override: profile.datamodel?.masteryOverridesStatus === true,
    logLevel: 5
  });
  if (saved) {
    api.loadFromJSON(saved);
    const wasSuspended = saved.core?.exit === 'suspend';
    api.cmi.core.entry = wasSuspended ? 'resume' : '';
    api.cmi.core.exit = '';
  } else {
    api.cmi.core.entry = 'ab-initio';
  }
  api.cmi.core.student_id = 'learner-1';
  api.cmi.core.student_name = 'Doe, Alex';
  api.cmi.core.lesson_mode = 'normal';
  api.cmi.core.credit = 'credit';
  if (mastery) api.cmi.student_data.mastery_score = mastery;
  // What the LMS plays and what it gave back of the registration's last session.
  tell({
    kind: 'session',
    session: {
      reg, mode, limit, enforcement, entry: api.cmi.core.entry,
      profile: { id: profile.id, name: profile.name, launch: profile.launch?.default || 'iframe' },
      saved: saved ? { location: saved.core?.lesson_location || '', status: saved.core?.lesson_status || '', suspendData: saved.suspend_data || '' } : null
    }
  });

  const log = [];
  window.__lmsLog = log;
  let quirkError = null;
  const wrap = (name, fn) => (...args) => {
    let result;
    if (name === 'LMSSetValue' && args[0] === 'cmi.suspend_data' && String(args[1]).length > limit) {
      if (enforcement === 'truncate') result = fn(args[0], String(args[1]).slice(0, limit));
      else if (enforcement === 'reject') { quirkError = '405'; result = 'false'; }
      else result = fn(...args);
    } else if (name === 'LMSGetLastError' && quirkError) {
      result = quirkError;
    } else {
      if (name !== 'LMSGetLastError' && name !== 'LMSGetErrorString' && name !== 'LMSGetDiagnostic') quirkError = null;
      result = fn(...args);
    }
    const call = { t: Date.now(), method: name, args, result: String(result) };
    log.push(call);
    tell({ kind: 'call', call });
    // Every change of the course is committed at once: its state then is the course's.
    if (name === 'LMSCommit' || name === 'LMSFinish') tellState();
    return result;
  };
  window.API = {};
  for (const m of ['LMSInitialize', 'LMSFinish', 'LMSGetValue', 'LMSSetValue', 'LMSCommit', 'LMSGetLastError', 'LMSGetErrorString', 'LMSGetDiagnostic']) {
    window.API[m] = wrap(m, api[m].bind(api));
  }
  window.__lmsApi = api;

  const src = `/pkg/${pkg}/index.html`;
  const host = document.getElementById('frame-host');
  if (mode === 'iframe') {
    const f = document.createElement('iframe');
    f.src = src;
    f.title = 'Course';
    host.appendChild(f);
  } else if (mode === 'nested-iframe') {
    const f = document.createElement('iframe');
    f.src = `/lms/wrapper.html?src=${encodeURIComponent(src)}`;
    f.setAttribute('allow', profile.launch?.iframeAllow || '');
    host.appendChild(f);
  } else if (mode === 'popup' || mode === 'new-tab') {
    window.__content = window.open(src, 'elabora-content');
  } else if (mode === 'popup-chain') {
    window.__structure = window.open(`/lms/popup.html?src=${encodeURIComponent(src)}`, 'elabora-structure');
  }
  window.__lmsReady = true;

  // The course's window (same origin) and the player's hooks in it (window.__elabora).
  function hooks() {
    try {
      const frame = host.querySelector('iframe')?.contentWindow;
      const course = mode === 'iframe' ? frame : mode === 'nested-iframe' ? frame?.frames[0] : window.__content || window.__structure?.__content;
      return course?.__elabora ? { course, hooks: course.__elabora } : null;
    } catch { return null; }
  }
  function tellState() {
    const found = hooks();
    if (found) tell({ kind: 'state', state: found.hooks.state() });
  }
  if (!parent) return;
  // Each course the page shows (it may load again) is told once with its data, then its state at
  // each commit and the events it runs.
  let shown = null;
  let traced = 0;
  const tellEvents = () => {
    const entries = (shown?.hooks.trace || []).filter((entry) => entry.n > traced);
    if (!entries.length) return;
    traced = entries[entries.length - 1].n;
    tell({ kind: 'events', entries });
  };
  setInterval(() => {
    const found = hooks();
    if (!found || found.hooks === shown?.hooks) return;
    shown = found;
    traced = 0;
    tell({ kind: 'course', course: found.hooks.course });
    tellState();
    tellEvents();
    found.course.addEventListener('elabora:trace', tellEvents);
  }, 200);
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== parent || !data || data.type !== 'elabora/lms-ask') return;
    if (data.ask === 'set-variable' && hooks()?.hooks.setVariable?.(data.id, data.value) !== true) tellState();
  });
})();
