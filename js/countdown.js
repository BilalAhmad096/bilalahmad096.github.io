// Countdown to 27 March 2026 (local time)
(function () {
  const targetDate = new Date("2026-03-27T00:00:00").getTime();

  function updateCountdown() {
    const countdownGrid = document.getElementById("countdown");
    if (!countdownGrid) return; // Safeguard if script is loaded on other pages

    const now = new Date().getTime();
    const distance = targetDate - now;

    // If date is passed
    if (distance <= 0) {
      countdownGrid.innerHTML = "<div class=\"countdown-item\"><span class=\"count-num\">🎉</span><span class=\"count-label\">It’s the day!</span></div>";
      return;
    }

    const days = Math.floor(distance / (1000 * 60 * 60 * 24));
    const hours = Math.floor(
      (distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)
    );
    const minutes = Math.floor(
      (distance % (1000 * 60 * 60)) / (1000 * 60)
    );
    const seconds = Math.floor(
      (distance % (1000 * 60)) / 1000
    );

    document.getElementById("days").textContent = days;
    document.getElementById("hours").textContent = hours;
    document.getElementById("minutes").textContent = minutes;
    document.getElementById("seconds").textContent = seconds;
  }

  // Run immediately and then every second
  updateCountdown();
  setInterval(updateCountdown, 1000);
})();
