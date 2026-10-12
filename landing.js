// Landing page: pick a city, navigate to its own page (/<cityKey>). Reads
// localStorage directly (same keys app.js uses) rather than loading app.js
// itself - this page has no weather/events rendering of its own.
//
// The city picker here intentionally duplicates app.js's nav-picker/
// city-picker pattern (same .nav-picker CSS, same positionPopoverNear
// logic) rather than importing app.js, so landing.js stays a small,
// independent script - this page doesn't need weather/events/tickets code
// at all. It's the same visual dropdown used to switch cities on a city
// page, just driving a plain navigation here instead of an in-page swap.

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderWavyText(name) {
  const drips = [0, 1, 2].map(d => `<span class="drip" style="--d:${d}"></span>`).join("");
  return [...name]
    .map((ch, i) => {
      const display = ch === " " ? "&nbsp;" : escapeHtml(ch);
      return `<span class="letter" style="--i:${i}">${display}${drips}</span>`;
    })
    .join("");
}

function positionPopoverNear(popoverEl, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const pw = popoverEl.offsetWidth;
  const ph = popoverEl.offsetHeight;
  let left = rect.left;
  let top = rect.bottom + 6;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (top + ph > window.innerHeight - 8) top = rect.top - ph - 6;
  popoverEl.style.left = `${Math.max(8, left)}px`;
  popoverEl.style.top = `${Math.max(8, top)}px`;
}

function initCityPicker() {
  const toggleBtn = document.getElementById("city-select-toggle");

  const listEl = document.createElement("div");
  listEl.id = "city-select-list";
  listEl.className = "nav-picker hidden";
  listEl.setAttribute("role", "menu");
  listEl.innerHTML = [...CITIES]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(c => `<button type="button" data-city-key="${c.key}" role="menuitem">${escapeHtml(c.name)}</button>`)
    .join("");
  document.body.appendChild(listEl);

  const hideList = () => listEl.classList.add("hidden");

  listEl.addEventListener("click", ev => {
    const btn = ev.target.closest("button[data-city-key]");
    if (!btn) return;
    location.href = `/${btn.dataset.cityKey}`;
  });

  toggleBtn.addEventListener("click", ev => {
    ev.stopPropagation();
    if (!listEl.classList.contains("hidden")) {
      hideList();
      return;
    }
    listEl.classList.remove("hidden");
    positionPopoverNear(listEl, toggleBtn);
  });

  document.addEventListener("click", ev => {
    if (listEl.classList.contains("hidden")) return;
    if (ev.target.closest("#city-select-list") || ev.target.closest("#city-select-toggle")) return;
    hideList();
  });

  document.addEventListener("keydown", ev => {
    if (ev.key === "Escape") hideList();
  });

  window.addEventListener("scroll", hideList, true);
  window.addEventListener("resize", hideList);
}

function render() {
  const picker = document.getElementById("landing-city-picker");
  picker.innerHTML = `<button type="button" id="city-select-toggle" class="landing-city-toggle wavy-text">${renderWavyText("Select Your City")}</button>`;
  initCityPicker();

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
