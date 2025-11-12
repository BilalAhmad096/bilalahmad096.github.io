// js/backtotop.js
document.addEventListener('DOMContentLoaded', () => {
  // Create ribbon button
  const btn = document.createElement('button');
  btn.className = 'scroll-ribbon';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Back to top');
  btn.setAttribute('title', 'Back to top');

  // Icon + label (label hidden on mobile via CSS)
  btn.innerHTML = `
    <span class="sr-icon" aria-hidden="true">⬆</span>
    <span class="sr-label">Top</span>
  `;

  document.body.appendChild(btn);

  // Show/hide on scroll
  const THRESHOLD = 280;
  const toggle = () => {
    if (window.scrollY > THRESHOLD) {
      btn.classList.add('show');
    } else {
      btn.classList.remove('show');
    }
  };
  toggle();
  window.addEventListener('scroll', toggle, { passive: true });

  // Smooth scroll to top
  btn.addEventListener('click', () => {
    // use smooth unless user prefers reduced motion
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: prefersReduced ? 'auto' : 'smooth' });
  });
});
