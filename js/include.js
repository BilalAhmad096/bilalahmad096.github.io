async function loadHTML(elementId, filePath) {
  const container = document.getElementById(elementId);
  if (container) {
    try {
      const response = await fetch(filePath);
      if (response.ok) {
        const html = await response.text();
        container.innerHTML = html;
      } else {
        console.error("Failed to load", filePath, response.status);
      }
    } catch (err) {
      console.error("Error loading", filePath, err);
    }
  }
}

window.addEventListener("DOMContentLoaded", () => {
  loadHTML("header", "/_includes/header.html");
  loadHTML("footer", "/_includes/footer.html");
});
