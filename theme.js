/** Console theme: applies the stored light or dark choice before first paint, and cycles light, dark and system from the top-bar toggle. */
(() => {
  const KEY = 'dodonaTheme';
  const ORDER = ['light', 'dark', 'system'];
  const LABEL = { light: 'Light', dark: 'Dark', system: 'System' };
  const root = document.documentElement;

  const stored = () => {
    try {
      const value = localStorage.getItem(KEY);
      return ORDER.includes(value) ? value : 'system';
    } catch {
      return 'system';
    }
  };

  // "system" leaves no attribute, so prefers-color-scheme decides.
  const apply = choice => {
    if (choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
  };

  apply(stored());

  function wire() {
    const button = document.getElementById('d-theme');
    if (!button) return;
    const show = choice => {
      const next = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length];
      button.dataset.choice = choice;
      button.setAttribute('aria-label', `Theme: ${LABEL[choice].toLowerCase()}. Switch to ${LABEL[next].toLowerCase()}.`);
      const label = document.getElementById('d-theme-lbl');
      if (label) label.textContent = LABEL[choice];
    };
    show(stored());
    button.addEventListener('click', () => {
      const next = ORDER[(ORDER.indexOf(button.dataset.choice) + 1) % ORDER.length];
      try {
        if (next === 'system') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, next);
      } catch { /* storage blocked: the choice lasts for this page only */ }
      apply(next);
      show(next);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
