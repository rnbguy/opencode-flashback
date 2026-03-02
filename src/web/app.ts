import {
  Activity,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Folder,
  Github,
  Heart,
  Info,
  Moon,
  Plus,
  RotateCw,
  Search,
  Sun,
  Trash2,
  User,
  UserX,
  Workflow,
  X,
  createIcons,
} from "lucide";
import DOMPurify from "dompurify";
import { jsonrepair } from "jsonrepair";
import { marked } from "marked";

const API_BASE = "";
let csrfToken = "";

type Memory = {
  id: string;
  content: string;
  createdAt?: string;
  type?: string;
  tags?: string[];
};

type SearchResult = {
  memory: Memory;
};

type UserProfile = {
  exists?: boolean;
  displayName?: string;
  userId?: string;
  version?: number;
  lastAnalyzedAt?: string;
  updatedAt?: string;
  profileData?: Record<string, unknown> | string;
};

type ApiResult<T> = {
  success: boolean;
  data?: T;
  error?: string;
};

type State = {
  memories: Memory[];
  limit: number;
  offset: number;
  totalItems: number;
  currentView: "project" | "profile";
  searchQuery: string;
  isSearching: boolean;
  autoRefreshInterval: ReturnType<typeof setInterval> | null;
  userProfile: UserProfile | null;
};

const state: State = {
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

marked.use({
  gfm: true,
  breaks: true,
});

const lucideIcons = {
  Sun,
  Moon,
  Github,
  Folder,
  User,
  Search,
  X,
  ChevronLeft,
  ChevronRight,
  RotateCw,
  Plus,
  Trash2,
  UserX,
  Heart,
  Activity,
  Workflow,
  Info,
  ArrowRight,
};

function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { async: false });
  return DOMPurify.sanitize(html);
}

async function fetchAPI<T = unknown>(
  endpoint: string,
  options: RequestInit = {},
): Promise<ApiResult<T>> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const headers = new Headers(options.headers);
    if (
      options.method &&
      ["POST", "PUT", "DELETE"].includes(options.method.toUpperCase())
    ) {
      if (csrfToken) {
        headers.set("X-CSRF-Token", csrfToken);
      }
    }

    const response = await fetch(API_BASE + endpoint, {
      ...options,
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.status === 403) {
      showToast("Session expired -- please refresh the page", "error");
      return { success: false, error: "Session expired" };
    }

    const data = (await response.json()) as T & { error?: string };
    return {
      success: response.ok,
      data: response.ok ? data : undefined,
      error: response.ok ? undefined : data.error || "Unknown error",
    };
  } catch (error: unknown) {
    console.error("API Error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
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
  const toggleBtn = document.getElementById(
    "theme-toggle",
  ) as HTMLButtonElement;
  const sunIcon = toggleBtn.querySelector(".sun-icon") as HTMLElement;
  const moonIcon = toggleBtn.querySelector(".moon-icon") as HTMLElement;

  function updateIcons(theme: string | null): void {
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
    .addEventListener("change", (e: MediaQueryListEvent) => {
      if (!localStorage.getItem("flashback-theme")) {
        const newTheme = e.matches ? "dark" : "light";
        document.documentElement.setAttribute("data-theme", newTheme);
        updateIcons(newTheme);
      }
    });
}

function renderMemories(): void {
  const container = document.getElementById("memories-list") as HTMLDivElement;

  if (state.memories.length === 0) {
    container.innerHTML = '<div class="empty-state">No memories found</div>';
    return;
  }

  container.innerHTML = state.memories.map(renderMemoryCard).join("");
  createIcons({ icons: lucideIcons });
}

function renderMemoryCard(memory: Memory): string {
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

function updatePagination(): void {
  const currentPage = Math.floor(state.offset / state.limit) + 1;
  const totalPages = Math.ceil(state.totalItems / state.limit) || 1;

  const pageInfo = `Page ${currentPage} of ${totalPages}`;
  (document.getElementById("page-info-top") as HTMLSpanElement).textContent =
    pageInfo;
  (document.getElementById("page-info-bottom") as HTMLSpanElement).textContent =
    pageInfo;

  const hasPrev = state.offset > 0;
  const hasNext = state.offset + state.limit < state.totalItems;

  (document.getElementById("prev-page-top") as HTMLButtonElement).disabled =
    !hasPrev;
  (document.getElementById("next-page-top") as HTMLButtonElement).disabled =
    !hasNext;
  (document.getElementById("prev-page-bottom") as HTMLButtonElement).disabled =
    !hasPrev;
  (document.getElementById("next-page-bottom") as HTMLButtonElement).disabled =
    !hasNext;
}

function updateSectionTitle(): void {
  const title = state.isSearching
    ? `+- SEARCH RESULTS (${state.totalItems}) --`
    : `+- PROJECT MEMORIES (${state.totalItems}) --`;
  (document.getElementById("section-title") as HTMLHeadingElement).textContent =
    title;
}

async function loadStats() {
  const result = await fetchAPI<{ memoryCount: number }>("/api/diagnostics");
  if (result.success && result.data) {
    (document.getElementById("stats-total") as HTMLSpanElement).textContent =
      `Total: ${result.data.memoryCount}`;
  }
}

async function addMemory(e: SubmitEvent): Promise<void> {
  e.preventDefault();

  const content = (
    document.getElementById("add-content") as HTMLTextAreaElement
  ).value.trim();
  const type = (document.getElementById("add-type") as HTMLSelectElement).value;
  const tagsStr = (
    document.getElementById("add-tags") as HTMLInputElement
  ).value.trim();
  const tags = tagsStr
    ? tagsStr
        .split(",")
        .map((t) => t.trim())
        .filter((t) => Boolean(t))
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
    (document.getElementById("add-form") as HTMLFormElement).reset();
    state.offset = 0;
    await loadMemories();
    await loadStats();
  } else {
    showToast(result.error || "Failed to add memory", "error");
  }
}

async function loadMemories(): Promise<void> {
  showRefreshIndicator(true);

  let endpoint = `/api/memories?limit=${state.limit}&offset=${state.offset}`;

  if (state.isSearching) {
    endpoint = `/api/search?q=${encodeURIComponent(state.searchQuery || "")}&limit=${state.limit}&offset=${state.offset}`;
  }

  const result = await fetchAPI<
    Memory[] | { results: SearchResult[]; count: number }
  >(endpoint);

  showRefreshIndicator(false);

  if (result.success && result.data) {
    if (state.isSearching) {
      const searchData = result.data as {
        results: SearchResult[];
        count: number;
      };
      state.memories = searchData.results.map((r) => r.memory);
      state.totalItems = searchData.count;
    } else {
      state.memories = result.data as Memory[];
      // If not searching, we don't get a total count from the memories endpoint directly,
      // so we rely on the stats endpoint to update totalItems if we are on the first page
      if (state.offset === 0) {
        const statsResult = await fetchAPI<{ memoryCount: number }>(
          "/api/diagnostics",
        );
        if (statsResult.success && statsResult.data) {
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

async function deleteMemory(id: string): Promise<void> {
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

function performSearch(): void {
  const query = (
    document.getElementById("search-input") as HTMLInputElement
  ).value.trim();

  if (!query) {
    clearSearch();
    return;
  }

  state.searchQuery = query;
  state.isSearching = true;
  state.offset = 0;

  (
    document.getElementById("clear-search-btn") as HTMLButtonElement
  ).classList.remove("hidden");

  loadMemories();
}

function clearSearch(): void {
  state.searchQuery = "";
  state.isSearching = false;
  state.offset = 0;

  (document.getElementById("search-input") as HTMLInputElement).value = "";
  (
    document.getElementById("clear-search-btn") as HTMLButtonElement
  ).classList.add("hidden");

  loadMemories();
}

function changePage(delta: number): void {
  const newOffset = state.offset + delta * state.limit;
  if (newOffset < 0 || newOffset >= state.totalItems) return;

  state.offset = newOffset;
  loadMemories();
}

function showToast(message: string, type = "success"): void {
  const toast = document.getElementById("toast") as HTMLDivElement;
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.classList.remove("hidden");

  setTimeout(() => {
    toast.classList.add("hidden");
  }, 3000);
}

function showError(message: string): void {
  const container = document.getElementById("memories-list") as HTMLDivElement;
  container.innerHTML = `<div class="error-state">Error: ${escapeHtml(message)}</div>`;
}

function showRefreshIndicator(show: boolean): void {
  const indicator = document.getElementById(
    "refresh-indicator",
  ) as HTMLSpanElement;
  if (show) {
    indicator.classList.remove("hidden");
  } else {
    indicator.classList.add("hidden");
  }
}

function formatDate(isoString?: string): string {
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

function startAutoRefresh(): void {
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

async function loadUserProfile(): Promise<void> {
  const result = await fetchAPI<UserProfile>("/api/profile");
  if (result.success && result.data) {
    state.userProfile = result.data;
    renderUserProfile();
  } else {
    showError(result.error || "Failed to load profile");
  }
}

function renderUserProfile(): void {
  const container = document.getElementById(
    "profile-content",
  ) as HTMLDivElement;
  const profile = state.userProfile;

  if (!profile || !profile.exists) {
    container.innerHTML = `
      <div class="empty-state">
        <i data-lucide="user-x" class="icon-large"></i>
        <p>No user profile found yet.</p>
      </div>
    `;
    createIcons({ icons: lucideIcons });
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

  const parseField = (field: unknown): Array<Record<string, unknown>> => {
    if (!field) return [];
    let result = field;
    let lastResult: string | null = null;
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
    const flattened: Array<Record<string, unknown>> = [];
    const walk = (item: unknown): void => {
      if (Array.isArray(item)) item.forEach(walk);
      else if (item && typeof item === "object") {
        flattened.push(item as Record<string, unknown>);
      }
    };
    walk(result);
    return flattened;
  };

  const profileData =
    data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const preferences = parseField(profileData.preferences);
  const patterns = parseField(profileData.patterns);
  const workflows = parseField(profileData.workflows);

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
              .sort(
                (a, b) =>
                  (Number(b.confidence ?? 0) || 0) -
                  (Number(a.confidence ?? 0) || 0),
              )
              .map(
                (p) => `
              <div class="compact-card preference-card">
                <div class="card-top">
                  <span class="category-tag">${escapeHtml(String(p.category ?? "General"))}</span>
                  <div class="confidence-ring" style="--p:${Math.round((Number(p.confidence ?? 0) || 0) * 100)}">
                    <span>${Math.round((Number(p.confidence ?? 0) || 0) * 100)}%</span>
                  </div>
                </div>
                <div class="card-body">
                  <p class="card-text">${escapeHtml(String(p.description ?? ""))}</p>
                </div>
                ${
                  p.evidence &&
                  Array.isArray(p.evidence) &&
                  p.evidence.length > 0
                    ? `
                <div class="card-footer">
                  <span class="evidence-toggle" title="${escapeHtml(Array.isArray(p.evidence) ? p.evidence.map((item) => String(item)).join("\n") : String(p.evidence))}">
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
                  <span class="category-tag">${escapeHtml(String(p.category ?? "General"))}</span>
                </div>
                <div class="card-body">
                  <p class="card-text">${escapeHtml(String(p.description ?? ""))}</p>
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
                <div class="workflow-title">${escapeHtml(String(w.description ?? ""))}</div>
                <div class="workflow-steps-horizontal">
                  ${(Array.isArray(w.steps) ? w.steps : [])
                    .map(
                      (step, i) => `
                    <div class="step-node">
                      <span class="step-idx">${i + 1}</span>
                      <span class="step-content">${escapeHtml(String(step))}</span>
                    </div>
                    ${i < (Array.isArray(w.steps) ? w.steps.length : 0) - 1 ? '<i data-lucide="arrow-right" class="step-arrow"></i>' : ""}
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

  createIcons({ icons: lucideIcons });
}

function switchView(view: "project" | "profile"): void {
  state.currentView = view;

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    (btn as HTMLButtonElement).classList.remove("active");
  });

  if (view === "project") {
    (document.getElementById("tab-project") as HTMLButtonElement).classList.add(
      "active",
    );
    (
      document.getElementById("project-section") as HTMLDivElement
    ).classList.remove("hidden");
    (
      document.getElementById("profile-section") as HTMLDivElement
    ).classList.add("hidden");
    (document.querySelector(".controls") as HTMLDivElement).classList.remove(
      "hidden",
    );
    (document.querySelector(".add-section") as HTMLDivElement).classList.remove(
      "hidden",
    );
  } else if (view === "profile") {
    (document.getElementById("tab-profile") as HTMLButtonElement).classList.add(
      "active",
    );
    (
      document.getElementById("project-section") as HTMLDivElement
    ).classList.add("hidden");
    (
      document.getElementById("profile-section") as HTMLDivElement
    ).classList.remove("hidden");
    (document.querySelector(".controls") as HTMLDivElement).classList.add(
      "hidden",
    );
    (document.querySelector(".add-section") as HTMLDivElement).classList.add(
      "hidden",
    );
    loadUserProfile();
  }
}

function escapeHtml(text: string): string {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

document.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  await loadCsrfToken();

  (
    document.getElementById("tab-project") as HTMLButtonElement
  ).addEventListener("click", () => switchView("project"));
  (
    document.getElementById("tab-profile") as HTMLButtonElement
  ).addEventListener("click", () => switchView("profile"));

  (document.getElementById("search-btn") as HTMLButtonElement).addEventListener(
    "click",
    performSearch,
  );
  (
    document.getElementById("clear-search-btn") as HTMLButtonElement
  ).addEventListener("click", clearSearch);
  (
    document.getElementById("search-input") as HTMLInputElement
  ).addEventListener("keypress", (e: KeyboardEvent) => {
    if (e.key === "Enter") performSearch();
  });

  (document.getElementById("add-form") as HTMLFormElement).addEventListener(
    "submit",
    addMemory,
  );

  (
    document.getElementById("prev-page-top") as HTMLButtonElement
  ).addEventListener("click", () => changePage(-1));
  (
    document.getElementById("next-page-top") as HTMLButtonElement
  ).addEventListener("click", () => changePage(1));
  (
    document.getElementById("prev-page-bottom") as HTMLButtonElement
  ).addEventListener("click", () => changePage(-1));
  (
    document.getElementById("next-page-bottom") as HTMLButtonElement
  ).addEventListener("click", () => changePage(1));

  await loadStats();
  await loadMemories();

  startAutoRefresh();

  createIcons({ icons: lucideIcons });
});

(
  window as Window & { deleteMemory: (id: string) => Promise<void> }
).deleteMemory = deleteMemory;
