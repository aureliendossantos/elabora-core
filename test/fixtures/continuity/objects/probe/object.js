// A probe for the continuity tests (D65): it says which block it is shown for, counts its mounts and
// updates, and keeps the last transition it received where the tests read it.
export function mount(container, ctx) {
  const { host } = ctx;
  let props = { ...ctx.props };
  const saved = ctx.savedState || {};
  const state = { mounts: (saved.mounts || 0) + 1, updates: saved.updates || 0, clicks: saved.clicks || 0, label: props.label };
  const transitions = [];
  const label = document.createElement('p');
  const words = document.createElement('p');
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Probe';
  container.append(label, words, button);
  const apply = () => { label.textContent = props.label; words.textContent = ctx.t('hello'); state.label = props.label; document.title = JSON.stringify({ ...state, transitions }); };
  button.addEventListener('click', () => { state.clicks++; apply(); host.emit('probed', { label: props.label }); });
  apply();
  const stop = host.onFrame(() => {});
  return {
    update(next, transition) {
      props = { ...props, ...next };
      state.updates++;
      if (transition) transitions.push({ ...transition, safeArea: { ...ctx.safeArea } });
      apply();
    },
    getState() { return { ...state }; },
    setState(next) { Object.assign(state, next || {}); apply(); },
    dispose() { stop(); container.innerHTML = ''; }
  };
}
