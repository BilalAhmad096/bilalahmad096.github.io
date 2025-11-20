(function () {
  const inPages = location.pathname.toLowerCase().includes('/pages/');
  const base = inPages ? '..' : '.';

  const html = `
<footer class="site-footer">
  <div class="container-wide">
    <!-- Top row: collaborators' logos -->
    <div class="footer-top">
      <div class="footer-collab-row">
        <span class="footer-label">Collaborators:</span>
        <ul class=" footer-logos">
          <li><a href="https://www.bath.ac.uk/" target="_blank"><img src="${base}/image/Bath Logo.gif" alt="University of Bath"></a></li>
          <li><a href="https://www.sandia.gov/" target="_blank"><img src="${base}/image/Sandia.svg" alt="Sandia National Laboratories"></a></li>
          <li><a href="https://www.manchester.ac.uk/" target="_blank"><img src="${base}/image/manchester.png" alt="University of Manchester"></a></li>
          <li><a href="https://www.ed.ac.uk/" target="_blank"><img src="${base}/image/Edinburgh.png" alt="University of Edinburgh"></a></li>
          <li><a href="https://www.ukpowernetworks.co.uk/" target="_blank"><img src="${base}/image/ukpn.png" alt="UK Power Networks"></a></li>
          <li><a href="https://www.tneigroup.com/" target="_blank"><img src="${base}/image/TNEI-logo.jpg" alt="TNEI Consultancy"></a></li>
          <li><a href="https://www.royalholloway.ac.uk/" target="_blank"><img src="${base}/image/rhul.jpg" alt="Royal Holloway University of London"></a></li>
          <li><a href="https://www.iitr.ac.in/" target="_blank"><img src="${base}/image/iitr.png" alt="IIT Roorkee"></a></li>
          <li><a href="https://www.rwth-aachen.de/" target="_blank"><img src="${base}/image/rwth.png" alt="RWTH Aachen University"></a></li>
          <li><a href="https://www.amu.ac.in/" target="_blank"><img src="${base}/image/amu.jpg" alt="Aligarh Muslim University"></a></li>


          

        </ul>
      </div>
    </div>
    <div class="footer-bottom">
      <div class="footer-right">
        <a class="social" href="https://www.linkedin.com/in/mintorian" target="_blank" rel="noopener">
          <img class="social-icon" src="${base}/footer/icon-linkedin.svg" alt="LinkedIn">
        </a>
        <a class="social" href="https://github.com/BilalAhmad096" target="_blank" rel="noopener">
          <img class="social-icon" src="${base}/footer/icon-github.svg" alt="GitHub">
        </a>
        <a class="social" href="https://scholar.google.com/citations?user=Y-ShcXcAAAAJ" target="_blank" rel="noopener">
          <img class="social-icon" src="${base}/footer/icon-scholar.svg" alt="Google Scholar">
        </a>
        <a class="social" href="https://x.com/ahmadbilal096" target="_blank" rel="noopener">
          <img class="social-icon" src="${base}/footer/icon-x.svg" alt="X (Twitter)">
        </a>
        <a class="social" href="https://www.instagram.com/thebilalgram/" target="_blank" rel="noopener">
          <img class="social-icon" src="${base}/footer/icon-instagram.svg" alt="Instagram">
        </a>
        <a class="social" href="https://leetcode.com/u/mailboxforbilal/" target="_blank" rel="noopener">
          <img class="social-icon" src="${base}/footer/icon-leetcode.svg" alt="LeetCode">
        </a>
        <a class="social" href="https://www.hackerrank.com/profile/mailboxforbilal" target="_blank" rel="noopener">
          <img class="social-icon" src="${base}/footer/icon-hackerrank.svg" alt="HackerRank">
        </a>
      </div>
    </div>
  </div>
</footer>`;
  const mount = document.getElementById('footer');
  if (mount) mount.innerHTML = html;
})();
