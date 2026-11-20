/** Home page dashboard preview: a Play and Pause control, and no autoplay when the visitor prefers reduced motion. */
(() => {
  const video = document.getElementById('preview-video');
  const toggle = document.getElementById('preview-toggle');
  if (!video || !toggle) return;
  const label = toggle.querySelector('.preview-toggle-label');

  const show = playing => {
    toggle.dataset.state = playing ? 'playing' : 'paused';
    label.textContent = playing ? 'Pause' : 'Play';
  };

  video.addEventListener('play', () => show(true));
  video.addEventListener('pause', () => show(false));
  toggle.addEventListener('click', () => {
    if (video.paused) video.play().catch(() => show(false));
    else { video.pause(); show(false); }
  });

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    // Back to the poster, waiting for Play.
    video.removeAttribute('autoplay');
    video.pause();
    video.load();
    show(false);
  } else {
    // Autoplay can still be refused (data saver, battery saver), so the button says Play when it is.
    video.play().then(() => show(true), () => show(false));
  }
  toggle.hidden = false;
})();
