(function () {
  let cleanPath = location.pathname
    .replace(/\/index\.html$/i, '/')
    .replace(/\.html$/i, '/');

  if (/^\/(experience|publications|researchgroup|updates)$/i.test(cleanPath)) {
    cleanPath += '/';
  }

  if (cleanPath !== location.pathname) {
    history.replaceState(null, '', `${cleanPath}${location.search}${location.hash}`);
  }

  const base = '';

  const html = `
<a class="skip-link" href="#main-content">Skip to main content</a>
<header class="site-header">
  <div class="container-wide">
    <nav class="primary-nav" id="mainNav" aria-label="Primary">
      <div class="nav-left">

        <!-- Mobile Hamburger -->
        <button class="nav-toggle" id="navToggle" type="button" aria-label="Toggle navigation" aria-expanded="false" aria-controls="navMenu brandLogos">
          <span></span><span></span><span></span>
        </button>
      </div>

      <ul class="nav-list" id="navMenu">
        <li><a href="${base}/" class="nav-link" data-nav="home">Home</a></li>
        <li><a href="${base}/experience/" class="nav-link" data-nav="experience">Experience</a></li>
        <li><a href="${base}/publications/" class="nav-link" data-nav="publications">Publications</a></li>
        <li><a href="${base}/researchgroup/" class="nav-link" data-nav="researchgroup">Research Group</a></li>
        <li><a href="${base}/updates/" class="nav-link" data-nav="updates">Updates</a></li>
      </ul>

      <ul class="brand-logos" id="brandLogos">
        <li><a href="https://www.bath.ac.uk/" target="_blank" rel="noopener noreferrer"><img src="${base}/image/bath-wordmark.png" alt="University of Bath"></a></li>
        <li><a href="https://www.royalholloway.ac.uk/" target="_blank" rel="noopener noreferrer"><img src="${base}/image/rhul.jpg" alt="Royal Holloway University of London"></a></li>
        <li><a href="https://www.iitr.ac.in/" target="_blank" rel="noopener noreferrer"><img src="${base}/image/iitr.png" alt="IIT Roorkee"></a></li>
        <li><a href="https://www.rwth-aachen.de/" target="_blank" rel="noopener noreferrer"><img src="${base}/image/rwth.png" alt="RWTH Aachen University"></a></li>
        <li><a href="https://www.amu.ac.in/" target="_blank" rel="noopener noreferrer"><img src="${base}/image/amu.jpg" alt="Aligarh Muslim University"></a></li>
      </ul>
    </nav>
  </div>
</header>`;
  
  // The header is authored statically in each page so that crawlers (and
  // no-JS visitors) see the real nav links. Only inject as a fallback.
  const mount = document.getElementById('header');
  if (!mount) return;
  if (!mount.querySelector('.site-header')) mount.innerHTML = html;

  // highlight active page
  const pathParts = location.pathname.split('/').filter(Boolean);
  const file = (pathParts.at(-1) || 'index').toLowerCase();
  const key = file.includes('experience') ? 'experience'
           : file.includes('publications') ? 'publications'
           : file.includes('researchgroup') ? 'researchgroup'
           : file.includes('updates') ? 'updates'
           : 'home';

  document.body.classList.add(`page-${key}`);

  document.querySelectorAll('.nav-link').forEach(a => {
    if (a.dataset.nav === key) {
      a.classList.add('active');
      a.setAttribute('aria-current', 'page');
    }
  });

  // Mobile toggle
  const nav = document.getElementById('mainNav');
  const toggle = document.getElementById('navToggle');

  // Closing the menu on an outside tap or on scroll only matters while it is
  // open, so those listeners are attached and removed alongside the class.
  let openScrollY = 0;

  const closeOnOutsideClick = event => {
    if (!nav.contains(event.target)) setMenuOpen(false);
  };

  const closeOnScroll = () => {
    // Opening the menu reflows the header, which some browsers report as a
    // small scroll. Ignore anything under a finger's worth of movement.
    if (Math.abs(window.scrollY - openScrollY) > 10) setMenuOpen(false);
  };

  const setMenuOpen = open => {
    nav.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));

    if (open) {
      openScrollY = window.scrollY;
      document.addEventListener('pointerdown', closeOnOutsideClick);
      window.addEventListener('scroll', closeOnScroll, { passive: true });
    } else {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      window.removeEventListener('scroll', closeOnScroll);
    }
  };

  toggle.addEventListener('click', () => {
    setMenuOpen(!nav.classList.contains('open'));
  });

  // Same-page links (and anything that leaves the menu up) should not leave a
  // stale open menu behind.
  nav.querySelectorAll('.nav-list a, .brand-logos a').forEach(a => {
    a.addEventListener('click', () => setMenuOpen(false));
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && nav.classList.contains('open')) {
      setMenuOpen(false);
      toggle.focus();
    }
  });

  // Back at desktop widths the menu is always visible, so drop the open state.
  const desktop = window.matchMedia('(min-width: 901px)');
  const syncDesktop = () => {
    if (desktop.matches && nav.classList.contains('open')) setMenuOpen(false);
  };
  desktop.addEventListener('change', syncDesktop);
})();
