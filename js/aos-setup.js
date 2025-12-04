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
    console.log(selector)
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




  AOS.init({
    offset: 20,
    duration: 800,
    easing: 'ease-in-out',
    mirror: true,
    once: false
  });
});
