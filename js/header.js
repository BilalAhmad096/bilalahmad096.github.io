(function () {
  let cleanPath = location.pathname
    .replace(/\/index\.html$/i, '/')
    .replace(/\.html$/i, '/');

  if (/^\/pages\/[^/]+$/i.test(cleanPath)) {
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
        <li><a href="${base}/pages/experience/" class="nav-link" data-nav="experience">Experience</a></li>
        <li><a href="${base}/pages/publications/" class="nav-link" data-nav="publications">Publications</a></li>
        <li><a href="${base}/pages/researchgroup/" class="nav-link" data-nav="researchgroup">Research Group</a></li>
        <li><a href="${base}/pages/updates/" class="nav-link" data-nav="updates">Updates</a></li>
      </ul>

      <ul class="brand-logos" id="brandLogos">
        <li><a href="https://www.bath.ac.uk/" target="_blank" rel="noopener noreferrer"><img src="${base}/image/Bath Logo.gif" alt="University of Bath"></a></li>
        <li><a href="https://www.royalholloway.ac.uk/" target="_blank" rel="noopener noreferrer"><img src="${base}/image/rhul.jpg" alt="Royal Holloway University of London"></a></li>
        <li><a href="https://www.iitr.ac.in/" target="_blank" rel="noopener noreferrer"><img src="${base}/image/iitr.png" alt="IIT Roorkee"></a></li>
        <li><a href="https://www.rwth-aachen.de/" target="_blank" rel="noopener noreferrer"><img src="${base}/image/rwth.png" alt="RWTH Aachen University"></a></li>
        <li><a href="https://www.amu.ac.in/" target="_blank" rel="noopener noreferrer"><img src="${base}/image/amu.jpg" alt="Aligarh Muslim University"></a></li>
      </ul>
    </nav>
  </div>
</header>`;
  
  const mount = document.getElementById('header');
  if (mount) mount.innerHTML = html;

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

  const setMenuOpen = open => {
    nav.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };

  toggle.addEventListener('click', () => {
    setMenuOpen(!nav.classList.contains('open'));
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && nav.classList.contains('open')) {
      setMenuOpen(false);
      toggle.focus();
    }
  });
})();
