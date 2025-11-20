(function () {
  const inPages = location.pathname.toLowerCase().includes('/pages/');
  const base = inPages ? '..' : '.';

  const html = `
<header class="site-header">
  <div class="container-wide">
    <nav class="primary-nav" id="mainNav" aria-label="Primary">
      <div class="nav-left">

        <!-- Mobile Hamburger -->
        <button class="nav-toggle" id="navToggle" aria-label="Toggle Navigation">
          <span></span><span></span><span></span>
        </button>
      </div>

      <ul class="nav-list">
        <li><a href="${base}/index.html" class="nav-link" data-nav="home">Home</a></li>
        <li><a href="${base}/pages/experience.html" class="nav-link" data-nav="experience">Experience</a></li>
        <li><a href="${base}/pages/publications.html" class="nav-link" data-nav="publications">Publications</a></li>
        <li><a href="${base}/pages/researchgroup.html" class="nav-link" data-nav="researchgroup">Research Group</a></li>
        <li><a href="${base}/pages/updates.html" class="nav-link" data-nav="updates">Updates</a></li>
      </ul>

      <ul class="brand-logos">
        <li><a href="https://www.bath.ac.uk/" target="_blank"><img src="${base}/image/Bath Logo.gif" alt="University of Bath"></a></li>
        <li><a href="https://www.royalholloway.ac.uk/" target="_blank"><img src="${base}/image/rhul.jpg" alt="Royal Holloway University of London"></a></li>
        <li><a href="https://www.iitr.ac.in/" target="_blank"><img src="${base}/image/iitr.png" alt="IIT Roorkee"></a></li>
        <li><a href="https://www.rwth-aachen.de/" target="_blank"><img src="${base}/image/rwth.png" alt="RWTH Aachen University"></a></li>
        <li><a href="https://www.amu.ac.in/" target="_blank"><img src="${base}/image/amu.jpg" alt="Aligarh Muslim University"></a></li>
      </ul>
    </nav>
  </div>
</header>`;
  
  const mount = document.getElementById('header');
  if (mount) mount.innerHTML = html;

  // highlight active page
  const file = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const key = file.includes('experience') ? 'experience'
           : file.includes('publications') ? 'publications'
           : file.includes('researchgroup') ? 'researchgroup'
           : file.includes('updates') ? 'updates'
           : 'home';

  document.body.classList.add(`page-${key}`);

  document.querySelectorAll('.nav-link').forEach(a => {
    if (a.dataset.nav === key) a.classList.add('active');
  });

  // Mobile toggle
  document.addEventListener("click", e => {
    if (e.target.id === "navToggle" || e.target.closest("#navToggle")) {
      document.getElementById("mainNav").classList.toggle("open");
    }
  });
})();
