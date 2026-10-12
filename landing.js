// Landing page: pick a city, navigate to its own page (/<cityKey>). Reads
// localStorage directly (same keys app.js uses) rather than loading app.js
// itself - this page has no weather/events rendering of its own.

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function render() {
  const grid = document.getElementById("landing-grid");
  grid.innerHTML = [...CITIES]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => `<a class="city-tile" href="/${c.key}">${escapeHtml(c.name)}</a>`)
    .join("");

  const continueBox = document.getElementById("landing-continue");
  const savedKey = localStorage.getItem("cityKey");
  const savedCity = CITIES.find(c => c.key === savedKey);
  if (savedCity) {
    continueBox.classList.remove("hidden");
    continueBox.innerHTML = `<a class="continue-btn" href="/${savedCity.key}">Continue to ${escapeHtml(savedCity.name)}</a>`;
  } else {
    continueBox.classList.add("hidden");
    continueBox.innerHTML = "";
  }
}

render();
