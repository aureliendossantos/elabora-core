// Fake LMS page: scorm-again's Scorm12API or Scorm2004API (the package's format: ?format=scorm12 or
// scorm2004) configured from an executable profile, plus the quirks that profiles document
// (suspend_data limit and enforcement, mastery override, launch topology).
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
  const asked = q.get('format');
  const format = asked === 'scorm2004' ? 'scorm2004' : 'scorm12';
  const scorm2004 = format === 'scorm2004';
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `/lms/scorm-again/${format}.js`;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  const profile = await fetch(`/lms/profile/${q.get('profile') || 'unknown'}`).then((r) => r.json());
  const host = document.getElementById('frame-host');
  // cmi5 and xAPI talk to the server's LRS (lrs.ts): the page only launches them
  // with the parameters an LMS gives.
  if (asked === 'cmi5' || asked === 'xapi') {
    window.__lmsLog = [];
    const params = await fetch(`/lms/launch-params/${reg}?format=${asked}&pkg=${encodeURIComponent(pkg)}`).then((r) => r.text());
    launch(`/pkg/${pkg}/index.html?${params}`);
    return;
  }
  const saved = await fetch(`/lms/state/${reg}`).then((r) => r.json());
  const limit = (scorm2004 ? profile.datamodel?.suspendDataMax?.scorm2004 : profile.datamodel?.suspendDataMax?.scorm12) ?? (scorm2004 ? 64000 : 4096);
  const enforcement = profile.datamodel?.suspendDataEnforcement || 'reject';
  const autocommit = profile.harness?.autocommitSeconds || 0;
  const parent = window.parent !== window ? window.parent : null;
  const tell = (message) => { if (parent) parent.postMessage({ type: 'elabora/lms', ...message }, '*'); };

  const settings = {
    lmsCommitUrl: `/lms/commit/${reg}`,
    autocommit: autocommit > 0,
    autocommitSeconds: autocommit || 60,
    dataCommitFormat: 'json',
    useAsynchronousCommits: profile.harness?.syncCommits === false,
    asyncModeBeaconBehavior: 'never',
    logLevel: 5
  };
  const api = scorm2004 ? new window.Scorm2004API(settings) : new window.Scorm12API({ ...settings, mastery_override: profile.datamodel?.masteryOverridesStatus === true });
  let entry;
  if (scorm2004) {
    if (saved) api.loadFromJSON(saved);
    entry = saved ? (saved.exit === 'suspend' ? 'resume' : '') : 'ab-initio';
    api.cmi.entry = entry;
    api.cmi.learner_id = 'learner-1';
    api.cmi.learner_name = 'Doe, Alex';
    api.cmi.mode = 'normal';
    api.cmi.credit = 'credit';
    if (mastery) api.cmi.scaled_passing_score = String(Number(mastery) / 100);
    // The learner's preferred language, as an LMS that fills it gives it (D71; most leave it empty).
    if (q.get('learnerLanguage')) api.cmi.learner_preference.language = q.get('learnerLanguage');
  } else {
    if (saved) {
      api.loadFromJSON(saved);
      api.cmi.core.entry = saved.core?.exit === 'suspend' ? 'resume' : '';
      api.cmi.core.exit = '';
    } else {
      api.cmi.core.entry = 'ab-initio';
    }
    entry = api.cmi.core.entry;
    api.cmi.core.student_id = 'learner-1';
    api.cmi.core.student_name = 'Doe, Alex';
    api.cmi.core.lesson_mode = 'normal';
    api.cmi.core.credit = 'credit';
    if (mastery) api.cmi.student_data.mastery_score = mastery;
    if (q.get('learnerLanguage')) api.cmi.student_preference.language = q.get('learnerLanguage');
  }
  // What the LMS plays and what it gave back of the registration's last session (in SCORM 1.2's
  // words: SCORM 2004's two statuses as one).
  const savedStatus = () => (scorm2004 ? (saved.success_status === 'passed' || saved.success_status === 'failed' ? saved.success_status : saved.completion_status === 'unknown' ? '' : saved.completion_status || '') : saved.core?.lesson_status || '');
  tell({
    kind: 'session',
    session: {
      reg, mode, format, limit, enforcement, entry,
      profile: { id: profile.id, name: profile.name, launch: profile.launch?.default || 'iframe' },
      saved: saved ? { location: (scorm2004 ? saved.location : saved.core?.lesson_location) || '', status: savedStatus(), suspendData: saved.suspend_data || '' } : null
    }
  });

  const log = [];
  window.__lmsLog = log;
  let quirkError = null;
  const names = scorm2004
    ? { set: 'SetValue', lastError: 'GetLastError', errorString: 'GetErrorString', diagnostic: 'GetDiagnostic', commit: 'Commit', finish: 'Terminate', all: ['Initialize', 'Terminate', 'GetValue', 'SetValue', 'Commit', 'GetLastError', 'GetErrorString', 'GetDiagnostic'] }
    : { set: 'LMSSetValue', lastError: 'LMSGetLastError', errorString: 'LMSGetErrorString', diagnostic: 'LMSGetDiagnostic', commit: 'LMSCommit', finish: 'LMSFinish', all: ['LMSInitialize', 'LMSFinish', 'LMSGetValue', 'LMSSetValue', 'LMSCommit', 'LMSGetLastError', 'LMSGetErrorString', 'LMSGetDiagnostic'] };
  const wrap = (name, fn) => (...args) => {
    let result;
    if (name === names.set && args[0] === 'cmi.suspend_data' && String(args[1]).length > limit) {
      if (enforcement === 'truncate') result = fn(args[0], String(args[1]).slice(0, limit));
      else if (enforcement === 'reject') { quirkError = scorm2004 ? '406' : '405'; result = 'false'; }
      else result = fn(...args);
    } else if (name === names.lastError && quirkError) {
      result = quirkError;
    } else {
      if (name !== names.lastError && name !== names.errorString && name !== names.diagnostic) quirkError = null;
      result = fn(...args);
    }
    const call = { t: Date.now(), method: name, args, result: String(result) };
    log.push(call);
    tell({ kind: 'call', call });
    // Every change of the course is committed at once: its state then is the course's.
    if (name === names.commit || name === names.finish) tellState();
    return result;
  };
  const exposed = {};
  for (const m of names.all) exposed[m] = wrap(m, api[m].bind(api));
  if (scorm2004) window.API_1484_11 = exposed;
  else window.API = exposed;
  window.__lmsApi = api;

  launch(`/pkg/${pkg}/index.html`);
  // The content in the profile's topology: a frame, a frame in a frame, a window or a chain of windows.
  function launch(src) {
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
  }

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
