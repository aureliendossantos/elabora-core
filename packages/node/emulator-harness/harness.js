// Fake LMS page: scorm-again's Scorm12API configured from an executable profile, plus the quirks
// that profiles document (suspend_data limit and enforcement, mastery override, launch topology).
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
    log.push({ t: Date.now(), method: name, args, result: String(result) });
    return result;
  };
  window.API = {};
  for (const m of ['LMSInitialize', 'LMSFinish', 'LMSGetValue', 'LMSSetValue', 'LMSCommit', 'LMSGetLastError', 'LMSGetErrorString', 'LMSGetDiagnostic']) {
    window.API[m] = wrap(m, api[m].bind(api));
  }
  window.__lmsApi = api;

  const src = `/pkg/${pkg}/index.html`;
  document.getElementById('info').textContent = `${profile.name} · ${mode} · registration ${reg} · suspend_data ≤ ${limit} (${enforcement})`;
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
})();
