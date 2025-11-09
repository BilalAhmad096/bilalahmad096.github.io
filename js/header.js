(function () {
  const inPages = location.pathname.toLowerCase().includes('/pages/');
  const base = inPages ? '..' : '.';

  const html = `
<header class="site-header">
  <div class="container-wide">
    <nav class="primary-nav" aria-label="Primary">
      <ul class="nav-list">
        <li><a href="${base}/index.html" class="nav-link" data-nav="home">Home</a></li>
        <li><a href="${base}/pages/education.html" class="nav-link" data-nav="education">Education</a></li>
        <li><a href="${base}/pages/publications.html" class="nav-link" data-nav="publications">Publications</a></li>
        <li><a href="${base}/pages/experience.html" class="nav-link" data-nav="experience">Experience</a></li>
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
  const key = file.includes('education') ? 'education'
           : file.includes('experience') ? 'experience'
           : file.includes('updates') ? 'updates'
           : 'home';
  document.querySelectorAll('.nav-link').forEach(a => {
    if (a.dataset.nav === key) a.classList.add('active');
  });
})();
