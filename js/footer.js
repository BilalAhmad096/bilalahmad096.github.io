(function () {
  const inPages = location.pathname.toLowerCase().includes('/pages/');
  const base = inPages ? '..' : '.';

  const html = `
<footer class="site-footer">
  <div class="container">
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
</footer>`;
  const mount = document.getElementById('footer');
  if (mount) mount.innerHTML = html;
})();
