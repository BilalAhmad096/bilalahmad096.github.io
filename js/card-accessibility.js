// js/card-accessibility.js
document.addEventListener('DOMContentLoaded', () => {
  const makeFocusable = (selector) => {
    document.querySelectorAll(selector).forEach(el => {
      // Make non-interactive cards keyboard-focusable for :focus-visible effects
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
      // Cursor hint
      el.style.cursor = 'pointer';
    });
  };

  makeFocusable('.skills-cards .skill-card');
  makeFocusable('.edu-list .edu-item');
  makeFocusable('.pub-list .pub-item');
});
