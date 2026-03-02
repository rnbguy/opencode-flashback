const API_BASE = "";
let csrfToken = "";

const state = {
  memories: [],
  limit: 20,
  offset: 0,
  totalItems: 0,
  currentView: "project",
  searchQuery: "",
  isSearching: false,
  autoRefreshInterval: null,
  userProfile: null,
};

marked.setOptions({
  gfm: true,
  breaks: true,
  headerIds: false,
  mangle: false,
});

function renderMarkdown(markdown) {
  const html = marked.parse(markdown);
  return DOMPurify.sanitize(html);
}

async function fetchAPI(endpoint, options = {}) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const headers = { ...options.headers };
    if (
      options.method &&
      ["POST", "PUT", "DELETE"].includes(options.method.toUpperCase())
    ) {
      if (csrfToken) {
        headers["X-CSRF-Token"] = csrfToken;
      }
    }

    const response = await fetch(API_BASE + endpoint, {
      ...options,
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.status === 403) {
      showToast("Session expired — please refresh the page", "error");
      return { success: false, error: "Session expired" };
    }

    const data = await response.json();
    return {
      success: response.ok,
      data: response.ok ? data : null,
      error: response.ok ? null : data.error || "Unknown error",
    };
  } catch (error) {
    console.error("API Error:", error);
    return { success: false, error: error.message };
  }
}

async function loadCsrfToken() {
  try {
    const response = await fetch(API_BASE + "/api/csrf-token");
    if (response.ok) {
      const data = await response.json();
      csrfToken = data.token;
    }
  } catch (error) {
    console.error("Failed to load CSRF token:", error);
  }
}

function initTheme() {
  const toggleBtn = document.getElementById("theme-toggle");
  const sunIcon = toggleBtn.querySelector(".sun-icon");
  const moonIcon = toggleBtn.querySelector(".moon-icon");

  function updateIcons(theme) {
    if (theme === "dark") {
      sunIcon.classList.remove("hidden");
      moonIcon.classList.add("hidden");
    } else {
      sunIcon.classList.add("hidden");
      moonIcon.classList.remove("hidden");
    }
  }

  const currentTheme = document.documentElement.getAttribute("data-theme");
  updateIcons(currentTheme);

  toggleBtn.addEventListener("click", () => {
    const newTheme =
      document.documentElement.getAttribute("data-theme") === "dark"
        ? "light"
        : "dark";
    document.documentElement.setAttribute("data-theme", newTheme);
    localStorage.setItem("flashback-theme", newTheme);
    updateIcons(newTheme);
  });

  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", (e) => {
      if (!localStorage.getItem("flashback-theme")) {
        const newTheme = e.matches ? "dark" : "light";
        document.documentElement.setAttribute("data-theme", newTheme);
        updateIcons(newTheme);
      }
    });
}

function renderMemories() {
  const container = document.getElementById("memories-list");

  if (state.memories.length === 0) {
    container.innerHTML = '<div class="empty-state">No memories found</div>';
    return;
  }

  container.innerHTML = state.memories.map(renderMemoryCard).join("");
  lucide.createIcons();
}

function renderMemoryCard(memory) {
  const createdDate = formatDate(memory.createdAt);

  const tagsHtml =
    memory.tags && memory.tags.length > 0
      ? `<div class="tags-list">${memory.tags.map((t) => `<span class="tag-badge">${escapeHtml(t)}</span>`).join("")}</div>`
      : "";

  return `
    <div class="memory-card" data-id="${memory.id}">
      <div class="memory-header">
        <div class="meta">
          ${memory.type ? `<span class="badge badge-type">${escapeHtml(memory.type)}</span>` : ""}
          <span class="memory-display-name">Memory</span>
        </div>
        <div class="memory-actions">
          <button class="btn-delete" onclick="deleteMemory('${memory.id}')">
            <i data-lucide="trash-2" class="icon"></i> Delete
          </button>
        </div>
      </div>
      ${tagsHtml}
      <div class="memory-content markdown-content">${renderMarkdown(memory.content)}</div>
      <div class="memory-footer">
        <span>Created: ${createdDate}</span>
        <span>ID: ${memory.id}</span>
      </div>
    </div>
  `;
}

function updatePagination() {
  const currentPage = Math.floor(state.offset / state.limit) + 1;
  const totalPages = Math.ceil(state.totalItems / state.limit) || 1;

  const pageInfo = `Page ${currentPage} of ${totalPages}`;
  document.getElementById("page-info-top").textContent = pageInfo;
  document.getElementById("page-info-bottom").textContent = pageInfo;

  const hasPrev = state.offset > 0;
  const hasNext = state.offset + state.limit < state.totalItems;

  document.getElementById("prev-page-top").disabled = !hasPrev;
  document.getElementById("next-page-top").disabled = !hasNext;
  document.getElementById("prev-page-bottom").disabled = !hasPrev;
  document.getElementById("next-page-bottom").disabled = !hasNext;
}

function updateSectionTitle() {
  const title = state.isSearching
    ? `└─ SEARCH RESULTS (${state.totalItems}) ──`
    : `└─ PROJECT MEMORIES (${state.totalItems}) ──`;
  document.getElementById("section-title").textContent = title;
}

async function loadStats() {
  const result = await fetchAPI("/api/diagnostics");
  if (result.success) {
    document.getElementById("stats-total").textContent =
      `Total: ${result.data.memoryCount}`;
  }
}

async function addMemory(e) {
  e.preventDefault();

  const content = document.getElementById("add-content").value.trim();
  const type = document.getElementById("add-type").value;
  const tagsStr = document.getElementById("add-tags").value.trim();
  const tags = tagsStr
    ? tagsStr
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t)
    : [];

  if (!content) {
    showToast("Content is required", "error");
    return;
  }

  const result = await fetchAPI("/api/memories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, type: type || undefined, tags }),
  });

  if (result.success) {
    showToast("Memory added successfully", "success");
    document.getElementById("add-form").reset();
    state.offset = 0;
    await loadMemories();
    await loadStats();
  } else {
    showToast(result.error || "Failed to add memory", "error");
  }
}

async function loadMemories() {
  showRefreshIndicator(true);

  let endpoint = `/api/memories?limit=${state.limit}&offset=${state.offset}`;

  if (state.isSearching) {
    endpoint = `/api/search?q=${encodeURIComponent(state.searchQuery || "")}&limit=${state.limit}&offset=${state.offset}`;
  }

  const result = await fetchAPI(endpoint);

  showRefreshIndicator(false);

  if (result.success) {
    if (state.isSearching) {
      state.memories = result.data.results.map((r) => r.memory);
      state.totalItems = result.data.count;
    } else {
      state.memories = result.data;
      // If not searching, we don't get a total count from the memories endpoint directly,
      // so we rely on the stats endpoint to update totalItems if we are on the first page
      if (state.offset === 0) {
        const statsResult = await fetchAPI("/api/diagnostics");
        if (statsResult.success) {
          state.totalItems = statsResult.data.memoryCount;
        }
      }
    }

    renderMemories();
    updatePagination();
    updateSectionTitle();
  } else {
    showError(result.error || "Failed to load memories");
  }
}

async function deleteMemory(id) {
  if (!confirm("Delete this memory?")) return;

  const result = await fetchAPI(`/api/memories/${id}`, {
    method: "DELETE",
  });

  if (result.success) {
    showToast("Memory deleted", "success");
    await loadMemories();
    await loadStats();
  } else {
    showToast(result.error || "Failed to delete", "error");
  }
}

function performSearch() {
  const query = document.getElementById("search-input").value.trim();

  if (!query) {
    clearSearch();
    return;
  }

  state.searchQuery = query;
  state.isSearching = true;
  state.offset = 0;

  document.getElementById("clear-search-btn").classList.remove("hidden");

  loadMemories();
}

function clearSearch() {
  state.searchQuery = "";
  state.isSearching = false;
  state.offset = 0;

  document.getElementById("search-input").value = "";
  document.getElementById("clear-search-btn").classList.add("hidden");

  loadMemories();
}

function changePage(delta) {
  const newOffset = state.offset + delta * state.limit;
  if (newOffset < 0 || newOffset >= state.totalItems) return;

  state.offset = newOffset;
  loadMemories();
}

function showToast(message, type = "success") {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.classList.remove("hidden");

  setTimeout(() => {
    toast.classList.add("hidden");
  }, 3000);
}

function showError(message) {
  const container = document.getElementById("memories-list");
  container.innerHTML = `<div class="error-state">Error: ${escapeHtml(message)}</div>`;
}

function showRefreshIndicator(show) {
  const indicator = document.getElementById("refresh-indicator");
  if (show) {
    indicator.classList.remove("hidden");
  } else {
    indicator.classList.add("hidden");
  }
}

function formatDate(isoString) {
  if (!isoString) return "Unknown";
  const date = new Date(isoString);
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function startAutoRefresh() {
  if (state.autoRefreshInterval) {
    clearInterval(state.autoRefreshInterval);
  }

  state.autoRefreshInterval = setInterval(() => {
    loadStats();
    if (!state.isSearching) {
      loadMemories();
    }
  }, 30000);
}

async function loadUserProfile() {
  const result = await fetchAPI("/api/profile");
  if (result.success) {
    state.userProfile = result.data;
    renderUserProfile();
  } else {
    showError(result.error || "Failed to load profile");
  }
}

function renderUserProfile() {
  const container = document.getElementById("profile-content");
  const profile = state.userProfile;

  if (!profile || !profile.exists) {
    container.innerHTML = `
      <div class="empty-state">
        <i data-lucide="user-x" class="icon-large"></i>
        <p>No user profile found yet.</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  let data = profile.profileData;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch (e) {
      console.error("Failed to parse profileData string", e);
    }
  }

  const parseField = (field) => {
    if (!field) return [];
    let result = field;
    let lastResult = null;
    while (typeof result === "string" && result !== lastResult) {
      lastResult = result;
      try {
        result = JSON.parse(
          typeof jsonrepair === "function" ? jsonrepair(result) : result,
        );
      } catch {
        break;
      }
    }
    if (!Array.isArray(result)) return [];
    const flattened = [];
    const walk = (item) => {
      if (Array.isArray(item)) item.forEach(walk);
      else if (item && typeof item === "object") flattened.push(item);
    };
    walk(result);
    return flattened;
  };

  const preferences = parseField(data.preferences);
  const patterns = parseField(data.patterns);
  const workflows = parseField(data.workflows);

  container.innerHTML = `
    <div class="profile-header">
      <div class="profile-info">
        <h3>${escapeHtml(profile.displayName || profile.userId || "User")}</h3>
        <div class="profile-stats">
          <div class="stat-pill">
            <span class="label">VERSION</span>
            <span class="value">${profile.version || 1}</span>
          </div>
          <div class="stat-pill">
            <span class="label">LAST UPDATED</span>
            <span class="value">${formatDate(profile.lastAnalyzedAt || profile.updatedAt)}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="dashboard-grid">
      <div class="dashboard-section preferences-section">
        <h4><i data-lucide="heart" class="icon"></i> PREFERENCES <span class="count">${preferences.length}</span></h4>
        ${
          preferences.length === 0
            ? '<p class="empty-text">No preferences learned yet</p>'
            : `
          <div class="cards-grid">
            ${preferences
              .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
              .map(
                (p) => `
              <div class="compact-card preference-card">
                <div class="card-top">
                  <span class="category-tag">${escapeHtml(p.category || "General")}</span>
                  <div class="confidence-ring" style="--p:${Math.round((p.confidence || 0) * 100)}">
                    <span>${Math.round((p.confidence || 0) * 100)}%</span>
                  </div>
                </div>
                <div class="card-body">
                  <p class="card-text">${escapeHtml(p.description || "")}</p>
                </div>
                ${
                  p.evidence && p.evidence.length > 0
                    ? `
                <div class="card-footer">
                  <span class="evidence-toggle" title="${escapeHtml(Array.isArray(p.evidence) ? p.evidence.join("\n") : p.evidence)}">
                    <i data-lucide="info" class="icon-xs"></i> ${Array.isArray(p.evidence) ? p.evidence.length : 1} evidence
                  </span>
                </div>`
                    : ""
                }
              </div>
            `,
              )
              .join("")}
          </div>
        `
        }
      </div>

      <div class="dashboard-section patterns-section">
        <h4><i data-lucide="activity" class="icon"></i> PATTERNS <span class="count">${patterns.length}</span></h4>
        ${
          patterns.length === 0
            ? '<p class="empty-text">No patterns detected yet</p>'
            : `
          <div class="cards-grid">
            ${patterns
              .map(
                (p) => `
              <div class="compact-card pattern-card">
                <div class="card-top">
                  <span class="category-tag">${escapeHtml(p.category || "General")}</span>
                </div>
                <div class="card-body">
                  <p class="card-text">${escapeHtml(p.description || "")}</p>
                </div>
              </div>
            `,
              )
              .join("")}
          </div>
        `
        }
      </div>

      <div class="dashboard-section workflows-section full-width">
        <h4><i data-lucide="workflow" class="icon"></i> WORKFLOWS <span class="count">${workflows.length}</span></h4>
        ${
          workflows.length === 0
            ? '<p class="empty-text">No workflows identified yet</p>'
            : `
          <div class="workflows-grid">
            ${workflows
              .map(
                (w) => `
              <div class="workflow-row">
                <div class="workflow-title">${escapeHtml(w.description || "")}</div>
                <div class="workflow-steps-horizontal">
                  ${(w.steps || [])
                    .map(
                      (step, i) => `
                    <div class="step-node">
                      <span class="step-idx">${i + 1}</span>
                      <span class="step-content">${escapeHtml(step)}</span>
                    </div>
                    ${i < (w.steps || []).length - 1 ? '<i data-lucide="arrow-right" class="step-arrow"></i>' : ""}
                  `,
                    )
                    .join("")}
                </div>
              </div>
            `,
              )
              .join("")}
          </div>
        `
        }
      </div>
    </div>
  `;

  lucide.createIcons();
}

function switchView(view) {
  state.currentView = view;

  document
    .querySelectorAll(".tab-btn")
    .forEach((btn) => btn.classList.remove("active"));

  if (view === "project") {
    document.getElementById("tab-project").classList.add("active");
    document.getElementById("project-section").classList.remove("hidden");
    document.getElementById("profile-section").classList.add("hidden");
    document.querySelector(".controls").classList.remove("hidden");
    document.querySelector(".add-section").classList.remove("hidden");
  } else if (view === "profile") {
    document.getElementById("tab-profile").classList.add("active");
    document.getElementById("project-section").classList.add("hidden");
    document.getElementById("profile-section").classList.remove("hidden");
    document.querySelector(".controls").classList.add("hidden");
    document.querySelector(".add-section").classList.add("hidden");
    loadUserProfile();
  }
}

function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

document.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  await loadCsrfToken();

  document
    .getElementById("tab-project")
    .addEventListener("click", () => switchView("project"));
  document
    .getElementById("tab-profile")
    .addEventListener("click", () => switchView("profile"));

  document
    .getElementById("search-btn")
    .addEventListener("click", performSearch);
  document
    .getElementById("clear-search-btn")
    .addEventListener("click", clearSearch);
  document.getElementById("search-input").addEventListener("keypress", (e) => {
    if (e.key === "Enter") performSearch();
  });

  document.getElementById("add-form").addEventListener("submit", addMemory);

  document
    .getElementById("prev-page-top")
    .addEventListener("click", () => changePage(-1));
  document
    .getElementById("next-page-top")
    .addEventListener("click", () => changePage(1));
  document
    .getElementById("prev-page-bottom")
    .addEventListener("click", () => changePage(-1));
  document
    .getElementById("next-page-bottom")
    .addEventListener("click", () => changePage(1));

  await loadStats();
  await loadMemories();

  startAutoRefresh();

  lucide.createIcons();
});
