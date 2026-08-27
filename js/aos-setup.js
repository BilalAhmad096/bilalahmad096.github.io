// js/aos-setup.js
document.addEventListener('DOMContentLoaded', () => {
  const applyAOS = (selector, {
    effect = 'fade-up',
    offset = 20,
    delayStart = 0,
    delayStep = 100,
    duration = 900,
    easing = 'ease-in-out',
    mirror = true,
    once = false
  } = {}) => {
    document.querySelectorAll(selector).forEach((el, i) => {
      el.setAttribute('data-aos', effect);
      el.setAttribute('data-aos-offset', offset);
      el.setAttribute('data-aos-delay', String(delayStart + i * delayStep));
      el.setAttribute('data-aos-duration', String(duration));
      el.setAttribute('data-aos-easing', easing);
      el.setAttribute('data-aos-mirror', String(mirror));
      el.setAttribute('data-aos-once', String(once));
    });
  };

  // Titles
  applyAOS('.section-title', { delayStep: 0, duration: 800 });

  // Cards/items
  applyAOS('.skills-cards .skill-card', { delayStep: 120 });
  applyAOS('.edu-list .edu-item', { delayStep: 120 });
  applyAOS('.pub-list .pub-item', { delayStep: 120 }); // Publications page
  applyAOS('.xp-list .xp-item',   { delayStep: 120 }); // Experience page
  applyAOS('.rec-grid .rec-card', { delayStep: 120 }); // ⬅️ NEW: Recommendations
  applyAOS('.rg-list .rg-notice', { delayStep: 120 });

  // Initialize AOS
  AOS.init({
    offset: 20,
    duration: 800,
    easing: 'ease-in-out',
    mirror: true,
    once: false
  });
});

/**
 * Handles the expanding animation and accessibility states
 * for the Connect Section Divider. Both states occupy the same box, so
 * expanding never reflows the page and AOS needs no refresh.
 */
function setConnectExpanded(expanded) {
  const divider = document.getElementById('connectDivider');
  const actions = document.getElementById('connectActions');
  const button = document.getElementById('connectBtn');

  if (!divider || !actions) return;
  if (divider.classList.contains('is-expanded') === expanded) return;

  // Toggle the active class to trigger CSS transitions
  divider.classList.toggle('is-expanded', expanded);

  // Accessibility update: reveal/hide action items to screen readers
  actions.setAttribute('aria-hidden', String(!expanded));
  if (button) button.setAttribute('aria-expanded', String(expanded));

  actions.querySelectorAll('.connect-divider__action').forEach(action => {
    if (expanded) {
      action.removeAttribute('tabindex');
    } else {
      action.setAttribute('tabindex', '-1');
    }
  });

  // The expanded state hides the Connect button itself, so a click outside
  // the divider, a scroll, or Escape are the ways back out.
  if (expanded) {
    connectOpenScrollY = window.scrollY;
    document.addEventListener('pointerdown', closeConnectOnOutsideClick);
    document.addEventListener('keydown', closeConnectOnEscape);
    window.addEventListener('scroll', closeConnectOnScroll, { passive: true });

    // Optional: Auto-focus the first link for keyboard users
    const firstAction = actions.querySelector('.connect-divider__action');
    if (firstAction) {
      setTimeout(() => {
        // preventScroll, or the focus nudges the page and trips the
        // close-on-scroll handler straight away.
        if (divider.classList.contains('is-expanded')) firstAction.focus({ preventScroll: true });
      }, 300);
    }
  } else {
    document.removeEventListener('pointerdown', closeConnectOnOutsideClick);
    document.removeEventListener('keydown', closeConnectOnEscape);
    window.removeEventListener('scroll', closeConnectOnScroll);
  }
}

let connectOpenScrollY = 0;

function closeConnectOnScroll() {
  // Focusing the first action can nudge the page, so ignore small movements.
  if (Math.abs(window.scrollY - connectOpenScrollY) > 10) setConnectExpanded(false);
}

function closeConnectOnOutsideClick(event) {
  const divider = document.getElementById('connectDivider');
  if (divider && !divider.contains(event.target)) setConnectExpanded(false);
}

function closeConnectOnEscape(event) {
  if (event.key !== 'Escape') return;
  setConnectExpanded(false);
  const button = document.getElementById('connectBtn');
  if (button) button.focus();
}

// Kept for the inline onclick on the Connect button.
function expandConnectDivider() {
  setConnectExpanded(true);
}

/**
 * Magnetic pills: the Connect button and its two actions lean a few pixels
 * toward the pointer while it is over them, and settle back on the way out.
 * Pointer devices only — there is nothing to lean toward on a touchscreen —
 * and skipped when the visitor has asked for less motion.
 */
(function () {
  if (!window.matchMedia('(hover: hover)').matches) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const pills = document.querySelectorAll('.connect-divider__btn, .connect-divider__action');

  pills.forEach(pill => {
    pill.addEventListener('pointermove', event => {
      const rect = pill.getBoundingClientRect();
      const dx = (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
      const dy = (event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2);
      pill.style.setProperty('--mx', (dx * 7).toFixed(1) + 'px');
      pill.style.setProperty('--my', (dy * 5).toFixed(1) + 'px');
    });

    pill.addEventListener('pointerleave', () => {
      pill.style.setProperty('--mx', '0px');
      pill.style.setProperty('--my', '0px');
    });
  });
})();
