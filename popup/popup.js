document.addEventListener("DOMContentLoaded", async () => {
  const projectInput = document.getElementById("project-input");
  const analyzeBtn = document.getElementById("analyze-btn");
  const btnText = document.getElementById("btn-text");
  const btnSpinner = document.getElementById("btn-spinner");
  const errorMsg = document.getElementById("error-msg");
  const results = document.getElementById("results");
  const profileName = document.getElementById("profile-name");
  const reportContent = document.getElementById("report-content");
  const exportBtn = document.getElementById("export-btn");
  const copyBtn = document.getElementById("copy-btn");
  const copyText = document.getElementById("copy-text");
  const settingsBtn = document.getElementById("settings-btn");
  const savedList = document.getElementById("saved-list");
  const savedEmpty = document.getElementById("saved-empty");
  const savedCount = document.getElementById("saved-count");
  const savedBtn = document.getElementById("saved-btn");
  const savedBackBtn = document.getElementById("saved-back-btn");
  const downloadAllBtn = document.getElementById("download-all-btn");
  const mainView = document.getElementById("main-view");
  const savedView = document.getElementById("saved-view");
  const intelMapBtn = document.getElementById("intel-map-btn");
  const intelBtnText = document.getElementById("intel-btn-text");
  const intelBtnSpinner = document.getElementById("intel-btn-spinner");
  const intelMapResults = document.getElementById("intel-map-results");
  const processingOverlay = document.getElementById("processing-overlay");
  const processingText = document.getElementById("processing-text");

  let lastReport = { name: "", markdown: "", experience: [] };
  let lastIntelMap = null;
  let pollTimer = null;

  // Load saved project description
  const saved = await chrome.storage.local.get({ projectDescription: "" });
  projectInput.value = saved.projectDescription;

  // Render saved reports list
  await renderSavedReports();

  // Check if there's an in-flight or completed job from a previous popup session
  await checkExistingJob();

  // ── Tab detection — show correct button ────────────────────────

  async function detectTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url) return;
      if (tab.url.includes("linkedin.com/company/")) {
        analyzeBtn.classList.add("hidden");
        intelMapBtn.classList.remove("hidden");
      } else {
        analyzeBtn.classList.remove("hidden");
        intelMapBtn.classList.add("hidden");
      }
    } catch {}
  }
  await detectTab();
  // Re-detect when tab changes
  chrome.tabs.onActivated.addListener(detectTab);
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) detectTab();
  });

  // Save project description on change
  projectInput.addEventListener("input", () => {
    chrome.storage.local.set({ projectDescription: projectInput.value });
  });

  // Settings button
  settingsBtn.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  // Saved reports view toggle
  savedBtn.addEventListener("click", async () => {
    await renderSavedReports();
    mainView.classList.add("hidden");
    savedView.classList.remove("hidden");
  });

  savedBackBtn.addEventListener("click", () => {
    savedView.classList.add("hidden");
    mainView.classList.remove("hidden");
  });

  // ── Analyze button ───────────────────────────────────────────────

  analyzeBtn.addEventListener("click", async () => {
    const project = projectInput.value.trim();
    if (!project) {
      showError("Please describe your goal first.");
      return;
    }

    setLoading(true, "Scanning profile...");
    hideError();
    results.classList.add("hidden");
    intelMapResults.classList.add("hidden");

    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (!tab.url || !tab.url.includes("linkedin.com/in/")) {
        throw new Error(
          "Please navigate to a LinkedIn profile page (linkedin.com/in/...)."
        );
      }

      // Tell background to start the job
      await chrome.runtime.sendMessage({
        type: "startAnalysis",
        tabId: tab.id,
        projectDescription: project,
      });

      // Start polling for result
      startPolling();
    } catch (err) {
      showError(err.message);
      setLoading(false);
    }
  });

  // ── Polling ──────────────────────────────────────────────────────

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(pollJob, 800);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function pollJob() {
    const job = await chrome.runtime.sendMessage({ type: "getJobStatus" });
    if (!job) return;

    if (job.status === "scraping") {
      setLoading(true, "Scanning profile...");
    } else if (job.status === "enriching") {
      setLoading(true, "Researching companies...");
    } else if (job.status === "gathering_posts") {
      setLoading(true, "Gathering recent posts...");
    } else if (job.status === "gathering_mutual") {
      setLoading(true, "Finding mutual connections...");
    } else if (job.status === "analyzing") {
      setLoading(true, "Analyzing with AI...");
    } else if (job.status === "done") {
      stopPolling();
      lastReport = { ...job.result };
      displayReport(lastReport);
      setLoading(false);
      await autoSaveReport(lastReport);
      chrome.runtime.sendMessage({ type: "clearJob" });
    } else if (job.status === "error") {
      stopPolling();
      showError(job.error);
      setLoading(false);
      chrome.runtime.sendMessage({ type: "clearJob" });
    }
  }

  /**
   * On popup open, check if background has an in-flight or completed job.
   */
  async function checkExistingJob() {
    const job = await chrome.runtime.sendMessage({ type: "getJobStatus" });
    if (!job || job.status === "idle") return;

    if (job.status === "scraping" || job.status === "enriching" || job.status === "gathering_posts" || job.status === "gathering_mutual" || job.status === "analyzing") {
      // Job still running — resume polling
      const statusText =
        job.status === "scraping" ? "Scanning profile..." :
        job.status === "enriching" ? "Researching companies..." :
        job.status === "gathering_posts" ? "Gathering recent posts..." :
        job.status === "gathering_mutual" ? "Finding mutual connections..." :
        "Analyzing with AI...";
      setLoading(true, statusText);
      hideError();
      results.classList.add("hidden");
      startPolling();
    } else if (job.status === "done") {
      lastReport = { ...job.result };
      displayReport(lastReport);
      await autoSaveReport(lastReport);
      chrome.runtime.sendMessage({ type: "clearJob" });
    } else if (job.status === "error") {
      showError(job.error);
      chrome.runtime.sendMessage({ type: "clearJob" });
    }
  }

  // ── Autosave ──────────────────────────────────────────────────────

  async function autoSaveReport(report) {
    if (!report || !report.name || !report.markdown) return;

    const { savedReports = [] } = await chrome.storage.local.get({
      savedReports: [],
    });

    const idx = savedReports.findIndex(
      (r) => r.name === report.name && r.project === report.project
    );

    if (idx >= 0) {
      savedReports[idx] = { ...report };
    } else {
      savedReports.unshift({ ...report });
    }

    await chrome.storage.local.set({ savedReports });
    await renderSavedReports();
  }

  // ── Copy button ──────────────────────────────────────────────────

  copyBtn.addEventListener("click", async () => {
    if (!lastReport.name) return;
    const content = buildExportMarkdown(lastReport);
    await navigator.clipboard.writeText(content);
    copyText.textContent = "Copied!";
    setTimeout(() => {
      copyText.textContent = "Copy";
    }, 2000);
  });

  // ── Export button ────────────────────────────────────────────────

  exportBtn.addEventListener("click", () => {
    if (!lastReport.name) return;
    const content = buildExportMarkdown(lastReport);
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `linkedin-analysis-${slugify(lastReport.name)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ── Download All ────────────────────────────────────────────────

  downloadAllBtn.addEventListener("click", async () => {
    const { savedReports = [] } = await chrome.storage.local.get({
      savedReports: [],
    });
    if (savedReports.length === 0) return;

    let combined = `# LinkedIn Analyzer — All Saved Research\n\n`;
    combined += `*Exported ${new Date().toLocaleDateString()} — ${savedReports.length} reports*\n\n`;
    combined += `---\n\n`;

    for (const report of savedReports) {
      if (report.type === "intel_map") {
        combined += buildIntelMapMarkdown(report);
      } else {
        combined += buildExportMarkdown(report);
      }
      combined += `\n\n---\n\n`;
    }

    const blob = new Blob([combined], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `linkedin-research-all-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ── Saved Reports ────────────────────────────────────────────────

  async function renderSavedReports() {
    const { savedReports = [] } = await chrome.storage.local.get({
      savedReports: [],
    });

    savedList.innerHTML = "";

    if (savedReports.length === 0) {
      savedEmpty.classList.remove("hidden");
      savedCount.textContent = "";
      downloadAllBtn.classList.add("hidden");
    } else {
      downloadAllBtn.classList.remove("hidden");
      savedEmpty.classList.add("hidden");
      savedCount.textContent = `(${savedReports.length})`;

      for (let i = 0; i < savedReports.length; i++) {
        const report = savedReports[i];
        const item = document.createElement("div");
        item.className = "saved-item";

        const date = new Date(report.timestamp || Date.now());
        const dateStr = date.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        const projectSnippet = (report.project || "").substring(0, 50);
        const isIntelMap = report.type === "intel_map";
        const typeLabel = isIntelMap ? "Intel Map" : "Profile";

        item.innerHTML = `
          <div class="saved-item-info">
            <div class="saved-item-name"><span class="saved-type-badge ${isIntelMap ? "intel" : "profile"}">${typeLabel}</span> ${escapeHtml(report.name)}</div>
            <div class="saved-item-meta">${dateStr} · ${escapeHtml(projectSnippet)}${(report.project || "").length > 50 ? "..." : ""}</div>
          </div>
          <button class="saved-item-delete" data-index="${i}" title="Delete report">&times;</button>
        `;

        item
          .querySelector(".saved-item-info")
          .addEventListener("click", () => {
            savedView.classList.add("hidden");
            mainView.classList.remove("hidden");
            if (isIntelMap) {
              results.classList.add("hidden");
              displayIntelMap(report);
            } else {
              lastReport = { ...report };
              intelMapResults.classList.add("hidden");
              displayReport(lastReport);
            }
          });

        item
          .querySelector(".saved-item-delete")
          .addEventListener("click", async (e) => {
            e.stopPropagation();
            savedReports.splice(i, 1);
            await chrome.storage.local.set({ savedReports });
            await renderSavedReports();
          });

        savedList.appendChild(item);
      }
    }
  }

  // ── Display helpers ──────────────────────────────────────────────

  function displayReport(report) {
    if (report.profileUrl) {
      profileName.innerHTML = `Analysis: <a href="${escapeHtml(report.profileUrl)}" target="_blank" rel="noopener">${escapeHtml(report.name)}</a>`;
    } else {
      profileName.textContent = `Analysis: ${report.name}`;
    }
    const workExpHtml = buildWorkExperienceHtml(report.experience);
    const mdHtml = markdownToHtml(report.markdown);

    // Split LLM output: Executive Profile Summary goes first, then Work Experience, then rest
    // Find the second <h3> tag (first is Executive Profile Summary, second starts the next section)
    const firstH3 = mdHtml.indexOf("<h3>");
    const secondH3 = firstH3 >= 0 ? mdHtml.indexOf("<h3>", firstH3 + 4) : -1;

    let finalHtml;
    if (secondH3 > 0) {
      // Executive Summary + Work Experience + rest of sections
      finalHtml = mdHtml.substring(0, secondH3) + workExpHtml + mdHtml.substring(secondH3);
    } else {
      // Fallback: work experience at top
      finalHtml = workExpHtml + mdHtml;
    }

    // Append Paths to Connect section at the end if available
    const pathsHtml = buildPathsToConnectHtml(report.pathsToConnect);
    if (pathsHtml) {
      finalHtml += pathsHtml;
    }

    reportContent.innerHTML = finalHtml;
    results.classList.remove("hidden");
    hideError();
  }

  function buildPathsToConnectHtml(paths) {
    if (!paths) {
      // Show the section with an encouraging message even when no data yet
      return `<div class="paths-section"><h3>Paths to Connect</h3>
        <div class="path-stats"><div class="path-stats-label">Analyze more profiles to discover connections</div>
        <div class="path-stats-detail">As you analyze profiles, this section will automatically find shared companies, warm introductions, and connection paths across your network.</div></div></div>`;
    }

    const hasConnections =
      (paths.companyOverlaps && paths.companyOverlaps.length > 0) ||
      (paths.companyBridges && paths.companyBridges.length > 0) ||
      (paths.introductionChains && paths.introductionChains.length > 0);

    let html = '<div class="paths-section"><h3>Paths to Connect</h3>';

    // Mutual Connections (from LinkedIn)
    if (paths.mutualConnections && paths.mutualConnections.length > 0) {
      const analyzed = paths.mutualConnections.filter((mc) => mc.isAnalyzed);
      const notAnalyzed = paths.mutualConnections.filter((mc) => !mc.isAnalyzed);
      const totalCount = paths.networkStats?.mutualCount || paths.mutualConnections.length;

      html += '<div class="path-group">';
      html += `<div class="path-group-label mutual-label">Mutual Connections (${totalCount})</div>`;

      // Show analyzed mutual connections first (highlighted)
      for (const mc of analyzed) {
        html += '<div class="path-card mutual-analyzed">';
        html += '<div class="path-icon">&#x2B50;</div>';
        html += '<div class="path-body">';
        html += `<div class="path-name"><a href="${escapeHtml(mc.profileUrl)}" target="_blank" rel="noopener">${escapeHtml(mc.name)}</a> <span class="analyzed-badge">Analyzed</span></div>`;
        html += `<div class="path-detail">${escapeHtml(mc.title)}</div>`;
        if (mc.location) html += `<div class="path-meta">${escapeHtml(mc.location)}</div>`;
        if (mc.analyzedDate) html += `<div class="path-date">Analyzed ${escapeHtml(mc.analyzedDate)}</div>`;
        html += '</div></div>';
      }

      // Show first 5 non-analyzed mutual connections
      for (const mc of notAnalyzed.slice(0, 5)) {
        html += '<div class="path-card">';
        html += '<div class="path-icon">&#x1F465;</div>';
        html += '<div class="path-body">';
        html += `<div class="path-name"><a href="${escapeHtml(mc.profileUrl)}" target="_blank" rel="noopener">${escapeHtml(mc.name)}</a></div>`;
        html += `<div class="path-detail">${escapeHtml(mc.title)}</div>`;
        if (mc.location) html += `<div class="path-meta">${escapeHtml(mc.location)}</div>`;
        html += '</div></div>';
      }

      if (notAnalyzed.length > 5) {
        html += `<div class="path-more">+ ${notAnalyzed.length - 5} more mutual connections</div>`;
      }
      html += '</div>';
    }

    // Company Overlaps
    if (paths.companyOverlaps && paths.companyOverlaps.length > 0) {
      html += '<div class="path-group">';
      html += '<div class="path-group-label overlap-label">Shared Companies</div>';
      for (const o of paths.companyOverlaps) {
        html += '<div class="path-card">';
        html += '<div class="path-icon">&#x1F7E2;</div>';
        html += '<div class="path-body">';
        html += `<div class="path-name"><a href="${escapeHtml(o.savedProfileUrl)}" target="_blank" rel="noopener">${escapeHtml(o.savedName)}</a></div>`;
        html += `<div class="path-detail">Both worked at <strong>${escapeHtml(o.company)}</strong></div>`;
        const details = [];
        if (o.savedTitle && o.savedDuration)
          details.push(`${escapeHtml(o.savedName)}: ${escapeHtml(o.savedTitle)} (${escapeHtml(o.savedDuration)})`);
        if (o.targetTitle && o.targetDuration)
          details.push(`Target: ${escapeHtml(o.targetTitle)} (${escapeHtml(o.targetDuration)})`);
        if (details.length > 0)
          html += `<div class="path-meta">${details.join("<br>")}</div>`;
        if (o.analyzedDate)
          html += `<div class="path-date">Analyzed ${escapeHtml(o.analyzedDate)}</div>`;
        html += '</div></div>';
      }
      html += '</div>';
    }

    // Company Bridges
    if (paths.companyBridges && paths.companyBridges.length > 0) {
      html += '<div class="path-group">';
      html += '<div class="path-group-label bridge-label">People You Know at Their Company</div>';
      for (const b of paths.companyBridges) {
        html += '<div class="path-card">';
        html += '<div class="path-icon">&#x1F7E1;</div>';
        html += '<div class="path-body">';
        html += `<div class="path-name"><a href="${escapeHtml(b.savedProfileUrl)}" target="_blank" rel="noopener">${escapeHtml(b.savedName)}</a></div>`;
        html += `<div class="path-detail">Currently at <strong>${escapeHtml(b.company)}</strong> as ${escapeHtml(b.savedTitle)}</div>`;
        if (b.analyzedDate)
          html += `<div class="path-date">Analyzed ${escapeHtml(b.analyzedDate)}</div>`;
        html += '</div></div>';
      }
      html += '</div>';
    }

    // Introduction Chains
    if (paths.introductionChains && paths.introductionChains.length > 0) {
      html += '<div class="path-group">';
      html += '<div class="path-group-label chain-label">Potential Introductions</div>';
      for (const ic of paths.introductionChains) {
        html += '<div class="path-card">';
        html += '<div class="path-icon">&#x1F535;</div>';
        html += '<div class="path-body">';
        html += `<div class="path-name"><a href="${escapeHtml(ic.savedProfileUrl)}" target="_blank" rel="noopener">${escapeHtml(ic.savedName)}</a></div>`;
        html += `<div class="path-detail">Previously at <strong>${escapeHtml(ic.targetCompany)}</strong> as ${escapeHtml(ic.savedTitle)}</div>`;
        html += `<div class="path-meta">Could introduce you through their former colleagues</div>`;
        if (ic.analyzedDate)
          html += `<div class="path-date">Analyzed ${escapeHtml(ic.analyzedDate)}</div>`;
        html += '</div></div>';
      }
      html += '</div>';
    }

    if (!hasConnections) {
      html += '<div class="path-stats"><div class="path-stats-detail">No shared companies or warm paths found yet. Keep analyzing profiles to build your network graph.</div></div>';
    }

    // Network Stats
    if (paths.networkStats && paths.networkStats.totalAnalyzed > 0) {
      html += '<div class="path-stats">';
      html += `<div class="path-stats-label">Your Network: ${paths.networkStats.totalAnalyzed} profiles analyzed</div>`;
      const topCompanies = Object.entries(paths.networkStats.topCompanies || {}).slice(0, 3);
      if (topCompanies.length > 0) {
        html += `<div class="path-stats-detail">Top companies: ${topCompanies.map(([c, n]) => `${escapeHtml(c)} (${n})`).join(", ")}</div>`;
      }
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  function setLoading(loading, text) {
    analyzeBtn.disabled = loading;
    btnText.textContent = loading ? (text || "Analyzing...") : "Analyze Profile";
    btnSpinner.classList.toggle("hidden", !loading);
    toggleOverlay(loading, text);
  }

  function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.classList.remove("hidden");
  }

  function hideError() {
    errorMsg.classList.add("hidden");
  }

  function toggleOverlay(show, text) {
    if (show) {
      processingText.textContent = text || "Processing...";
      processingOverlay.classList.remove("hidden");
    } else {
      processingOverlay.classList.add("hidden");
    }
  }

  function slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function buildWorkExperienceHtml(experience) {
    if (!experience || experience.length === 0) return "";

    let html = "<h3>Work Experience</h3><ul class=\"work-exp\">";
    let i = 0;
    while (i < experience.length) {
      const entry = experience[i];
      if (typeof entry === "string") {
        html += `<li>${escapeHtml(entry)}</li>`;
        i++;
        continue;
      }

      // Check if this is part of a grouped company (has totalTenure)
      if (entry.totalTenure) {
        const company = entry.company;
        const totalTenure = entry.totalTenure;
        const groupedRoles = [];
        while (
          i < experience.length &&
          typeof experience[i] !== "string" &&
          experience[i].totalTenure === totalTenure &&
          experience[i].company === company
        ) {
          groupedRoles.push(experience[i]);
          i++;
        }
        html += `<li><strong>${escapeHtml(company)}</strong> · ${escapeHtml(totalTenure)}`;
        html += `<ul class="work-exp-details">`;
        for (const role of groupedRoles) {
          html += `<li><strong>${escapeHtml(role.title || "Unknown Role")}</strong>`;
          if (role.duration || role.location || role.description) {
            html += `<ul class="work-exp-details">`;
            if (role.duration) html += `<li>${escapeHtml(role.duration)}</li>`;
            if (role.location) html += `<li>${escapeHtml(role.location)}</li>`;
            if (role.description) html += `<li>${escapeHtml(role.description)}</li>`;
            html += `</ul>`;
          }
          html += `</li>`;
        }
        html += `</ul></li>`;
      } else {
        let title = `<strong>${escapeHtml(entry.title || "Unknown Role")}`;
        if (entry.company) title += ` at ${escapeHtml(entry.company)}`;
        title += `</strong>`;
        html += `<li>${title}`;
        if (entry.duration || entry.location || entry.description) {
          html += `<ul class="work-exp-details">`;
          if (entry.duration) html += `<li>${escapeHtml(entry.duration)}</li>`;
          if (entry.location) html += `<li>${escapeHtml(entry.location)}</li>`;
          if (entry.description) html += `<li>${escapeHtml(entry.description)}</li>`;
          html += `</ul>`;
        }
        html += `</li>`;
        i++;
      }
    }
    html += "</ul>";
    return html;
  }

  function buildWorkExperienceMd(experience) {
    if (!experience || experience.length === 0) return "";

    let md = "### Work Experience\n\n";
    let i = 0;
    while (i < experience.length) {
      const entry = experience[i];
      if (typeof entry === "string") {
        md += `* ${entry}\n`;
        i++;
        continue;
      }

      if (entry.totalTenure) {
        const company = entry.company;
        const totalTenure = entry.totalTenure;
        const groupedRoles = [];
        while (
          i < experience.length &&
          typeof experience[i] !== "string" &&
          experience[i].totalTenure === totalTenure &&
          experience[i].company === company
        ) {
          groupedRoles.push(experience[i]);
          i++;
        }
        md += `* **${company}** · ${totalTenure}\n`;
        for (const role of groupedRoles) {
          md += `  * **${role.title || "Unknown Role"}**`;
          if (role.duration) md += `\n    * ${role.duration}`;
          if (role.location) md += `\n    * ${role.location}`;
          if (role.description) md += `\n    * ${role.description}`;
          md += "\n";
        }
      } else {
        let line = `* **${entry.title || "Unknown Role"}`;
        if (entry.company) line += ` at ${entry.company}`;
        line += `**`;
        if (entry.duration) line += `\n  * ${entry.duration}`;
        if (entry.location) line += `\n  * ${entry.location}`;
        if (entry.description) line += `\n  * ${entry.description}`;
        md += line + "\n";
        i++;
      }
    }
    md += "\n";
    return md;
  }

  function insertWorkExperience(markdown, workExpMd) {
    if (!workExpMd) return markdown;
    // Insert Work Experience after Executive Profile Summary, before Relevant Skills
    // Try multiple possible markers the LLM might use
    const markers = ["### Relevant Skills", "### Relevant Experience"];
    for (const marker of markers) {
      const idx = markdown.indexOf(marker);
      if (idx > 0) {
        return markdown.substring(0, idx) + workExpMd + markdown.substring(idx);
      }
    }
    // Fallback: insert after the first section (after first ### ... block)
    const firstSectionEnd = markdown.indexOf("\n### ", 4);
    if (firstSectionEnd > 0) {
      return markdown.substring(0, firstSectionEnd + 1) + workExpMd + markdown.substring(firstSectionEnd + 1);
    }
    return workExpMd + markdown;
  }

  function buildExportMarkdown(report) {
    const workExpMd = buildWorkExperienceMd(report.experience);
    const finalMd = insertWorkExperience(report.markdown, workExpMd);
    const date = report.timestamp
      ? new Date(report.timestamp).toLocaleDateString()
      : new Date().toLocaleDateString();

    const pathsMd = buildPathsToConnectMd(report.pathsToConnect);

    return `# LinkedIn Profile Analysis: ${report.name}

* **Profile:** ${report.profileUrl || "N/A"}
* **Goal:** ${report.project}
* **Generated:** ${date}

---

${finalMd}
${pathsMd}`;
  }

  function buildIntelMapMarkdown(data) {
    if (!data) return "";
    const date = data.timestamp
      ? new Date(data.timestamp).toLocaleDateString()
      : new Date().toLocaleDateString();

    let md = `# Intel Map: ${data.companyName || "Company"}

* **Goal:** ${data.project || "N/A"}
* **Generated:** ${date}

---

### Warm Paths

`;

    if (data.warmPaths && data.warmPaths.length > 0) {
      for (const wp of data.warmPaths) {
        md += `* **${wp.name}** — ${wp.connection || ""}`;
        if (wp.analyzedDate) md += ` (Analyzed ${wp.analyzedDate})`;
        md += "\n";
      }
    } else {
      md += "*No warm paths found.*\n";
    }

    md += "\n### Target People\n\n";

    if (data.targetPeople && data.targetPeople.length > 0) {
      for (const tp of data.targetPeople) {
        md += `* **${tp.name}** — ${tp.title || ""}`;
        if (tp.role) md += ` [${tp.role}]`;
        if (tp.profileUrl) md += ` — [Profile](${tp.profileUrl})`;
        md += "\n";
        if (tp.relevance) md += `  * ${tp.relevance}\n`;
      }
    }

    md += "\n### Approach Sequence\n\n";

    if (data.approachSequence && data.approachSequence.length > 0) {
      for (const step of data.approachSequence) {
        const typeLabel = (step.type || "").replace(/_/g, " ");
        md += `${step.step || "-"}. **${step.person || ""}** (${typeLabel})`;
        if (step.via) md += ` — via ${step.via}`;
        md += "\n";
        if (step.action) md += `   * ${step.action}\n`;
        if (step.reason) md += `   * *${step.reason}*\n`;
      }
    }

    return md;
  }

  function buildPathsToConnectMd(paths) {
    if (!paths) return "";

    let md = "### Paths to Connect\n\n";

    if (paths.mutualConnections && paths.mutualConnections.length > 0) {
      const totalCount = paths.networkStats?.mutualCount || paths.mutualConnections.length;
      md += `**Mutual Connections (${totalCount})**\n`;
      const analyzed = paths.mutualConnections.filter((mc) => mc.isAnalyzed);
      const notAnalyzed = paths.mutualConnections.filter((mc) => !mc.isAnalyzed);
      for (const mc of analyzed) {
        md += `* **${mc.name}** — ${mc.title} *(Previously Analyzed)*\n`;
      }
      for (const mc of notAnalyzed.slice(0, 10)) {
        md += `* ${mc.name} — ${mc.title}\n`;
      }
      if (notAnalyzed.length > 10) {
        md += `* + ${notAnalyzed.length - 10} more mutual connections\n`;
      }
      md += "\n";
    }

    if (paths.companyOverlaps && paths.companyOverlaps.length > 0) {
      md += "**Shared Companies**\n";
      for (const o of paths.companyOverlaps) {
        md += `* **${o.savedName}** — Both worked at **${o.company}**`;
        if (o.savedDuration) md += ` (${o.savedDuration})`;
        if (o.analyzedDate) md += ` — Analyzed ${o.analyzedDate}`;
        md += "\n";
      }
      md += "\n";
    }

    if (paths.companyBridges && paths.companyBridges.length > 0) {
      md += "**People You Know at Their Company**\n";
      for (const b of paths.companyBridges) {
        md += `* **${b.savedName}** — Currently at **${b.company}** as ${b.savedTitle}`;
        if (b.analyzedDate) md += ` — Analyzed ${b.analyzedDate}`;
        md += "\n";
      }
      md += "\n";
    }

    if (paths.introductionChains && paths.introductionChains.length > 0) {
      md += "**Potential Introductions**\n";
      for (const ic of paths.introductionChains) {
        md += `* **${ic.savedName}** — Previously at **${ic.targetCompany}** as ${ic.savedTitle}`;
        if (ic.analyzedDate) md += ` — Analyzed ${ic.analyzedDate}`;
        md += "\n";
      }
      md += "\n";
    }

    if (paths.networkStats && paths.networkStats.totalAnalyzed > 0) {
      md += `*Your Network: ${paths.networkStats.totalAnalyzed} profiles analyzed*\n`;
    }

    return md;
  }

  function markdownToHtml(md) {
    // Merge numbered list items with their description paragraphs
    // Pattern: "1. **Title:**\n\nDescription text\n\n2. **Title:**..."
    // Becomes: "1. **Title:** Description text\n2. **Title:**..."
    let cleaned = md.replace(
      /^(\d+\.\s+.+?)\n\n+((?:(?!\d+\.\s|[-*]\s|###?\s|---).+\n?)+)/gm,
      (match, listItem, body) => {
        const trimmed = body.trim();
        if (!trimmed) return match;
        return listItem + " " + trimmed + "\n";
      }
    );

    // Also collapse blank lines between bullet items
    cleaned = cleaned
      .replace(/^(\d+\. .+)\n\n+(?=\d+\. )/gm, "$1\n")
      .replace(/^([-*] .+)\n\n+(?=[-*] )/gm, "$1\n");

    let html = cleaned
      .replace(/^### (.+)$/gm, "<h3>$1</h3>")
      .replace(/^## (.+)$/gm, "<h2>$1</h2>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      // Convert markdown links [text](url) to clickable links
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      // Convert bare URLs to clickable links
      .replace(/(?<!")(https?:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">source</a>')
      .replace(/^[-*] (.+)$/gm, "<li class=\"ul\">$1</li>")
      .replace(/^\d+\. (.+)$/gm, "<li class=\"ol\">$1</li>")
      .replace(/((?:<li class="ol">.*<\/li>\n?)+)/g, "<ol>$1</ol>")
      .replace(/((?:<li class="ul">.*<\/li>\n?)+)/g, "<ul>$1</ul>")
      .replace(/ class="[uo]l"/g, "")
      .replace(/^(?!<[hulo])((?!<).+)$/gm, "<p>$1</p>")
      .replace(/\n{2,}/g, "\n");

    return html;
  }

  // ── Intel Map ──────────────────────────────────────────────────

  intelMapBtn.addEventListener("click", async () => {
    const goal = projectInput.value.trim();
    if (!goal) {
      showError("Please describe your goal first.");
      return;
    }

    setIntelLoading(true, "Starting analysis...");
    hideError();
    results.classList.add("hidden");
    intelMapResults.classList.add("hidden");

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.url || !tab.url.includes("linkedin.com/company/")) {
        throw new Error("Please navigate to a LinkedIn company page.");
      }

      await chrome.runtime.sendMessage({
        type: "startIntelMap",
        tabId: tab.id,
        companyUrl: tab.url,
        goal,
      });

      startIntelPolling();
    } catch (err) {
      showError(err.message);
      setIntelLoading(false);
    }
  });

  let intelPollTimer = null;

  function startIntelPolling() {
    stopIntelPolling();
    intelPollTimer = setInterval(pollIntelJob, 800);
  }

  function stopIntelPolling() {
    if (intelPollTimer) {
      clearInterval(intelPollTimer);
      intelPollTimer = null;
    }
  }

  async function pollIntelJob() {
    const job = await chrome.runtime.sendMessage({ type: "getIntelJobStatus" });
    if (!job) return;

    const statusMap = {
      intel_scraping_company: "Researching company...",
      intel_scraping_people: "Scanning key people...",
      intel_cross_referencing: "Finding warm paths...",
      intel_analyzing: "Building engagement strategy...",
    };

    if (statusMap[job.status]) {
      setIntelLoading(true, statusMap[job.status]);
    } else if (job.status === "done") {
      stopIntelPolling();
      setIntelLoading(false);
      displayIntelMap(job.result);
      chrome.runtime.sendMessage({ type: "clearIntelJob" });
    } else if (job.status === "error") {
      stopIntelPolling();
      showError(job.error);
      setIntelLoading(false);
      chrome.runtime.sendMessage({ type: "clearIntelJob" });
    }
  }

  function setIntelLoading(loading, text) {
    intelMapBtn.disabled = loading;
    intelBtnText.textContent = loading ? (text || "Building...") : "Build Intel Map";
    intelBtnSpinner.classList.toggle("hidden", !loading);
    toggleOverlay(loading, text);
  }

  function displayIntelMap(data) {
    if (!data) return;
    lastIntelMap = data;

    let html = `<div class="results-header">`;
    html += `<h2 class="intel-title">${escapeHtml(data.companyName || "Company")} — Intel Map</h2>`;
    html += `<div class="results-actions">`;
    html += `<button id="intel-copy-btn" class="action-btn" title="Copy Markdown to clipboard">`;
    html += `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`;
    html += `<span id="intel-copy-text">Copy</span></button>`;
    html += `<button id="intel-export-btn" class="action-btn" title="Export as Markdown">`;
    html += `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>`;
    html += `Export .md</button>`;
    html += `</div></div>`;

    // Warm Paths
    html += `<div class="intel-tier">`;
    html += `<div class="intel-tier-header warm">Warm Paths</div>`;
    if (data.warmPaths && data.warmPaths.length > 0) {
      for (const wp of data.warmPaths) {
        html += `<div class="intel-card warm-card">`;
        html += `<div class="intel-card-dot warm-dot"></div>`;
        html += `<div class="intel-card-body">`;
        html += `<div class="intel-card-name">${escapeHtml(wp.name)}</div>`;
        html += `<div class="intel-card-detail">${escapeHtml(wp.connection || "")}</div>`;
        if (wp.analyzedDate) html += `<div class="intel-card-meta">Analyzed ${escapeHtml(wp.analyzedDate)}</div>`;
        html += `</div></div>`;
      }
    } else {
      html += `<div class="intel-empty">No warm paths found. Analyze more profiles to build your network.</div>`;
    }
    html += `</div>`;

    // Connector arrow
    html += `<div class="intel-arrow">▼</div>`;

    // Target People
    html += `<div class="intel-tier">`;
    html += `<div class="intel-tier-header target">Target People</div>`;
    if (data.targetPeople && data.targetPeople.length > 0) {
      for (const tp of data.targetPeople) {
        const roleClass = (tp.role || "").replace(/[^a-z_]/g, "");
        html += `<a href="${escapeHtml(tp.profileUrl || "#")}" target="_blank" rel="noopener" class="intel-card target-card">`;
        html += `<div class="intel-card-dot target-dot"></div>`;
        html += `<div class="intel-card-body">`;
        html += `<div class="intel-card-name">${escapeHtml(tp.name)} <span class="role-badge ${roleClass}">${escapeHtml(tp.role || "")}</span></div>`;
        html += `<div class="intel-card-detail">${escapeHtml(tp.title || "")}</div>`;
        if (tp.relevance) html += `<div class="intel-card-meta">${escapeHtml(tp.relevance)}</div>`;
        html += `</div></a>`;
      }
    }
    html += `</div>`;

    // Connector arrow
    html += `<div class="intel-arrow">▼</div>`;

    // Approach Sequence
    html += `<div class="intel-tier">`;
    html += `<div class="intel-tier-header approach">Approach Sequence</div>`;
    if (data.approachSequence && data.approachSequence.length > 0) {
      for (const step of data.approachSequence) {
        const typeLabel = (step.type || "").replace(/_/g, " ");
        html += `<div class="intel-card approach-card">`;
        html += `<div class="intel-step-num">${step.step || ""}</div>`;
        html += `<div class="intel-card-body">`;
        html += `<div class="intel-card-name">${escapeHtml(step.person || "")} <span class="type-badge">${escapeHtml(typeLabel)}</span></div>`;
        if (step.via) html += `<div class="intel-card-detail">Via: ${escapeHtml(step.via)}</div>`;
        html += `<div class="intel-card-detail">${escapeHtml(step.action || "")}</div>`;
        if (step.reason) html += `<div class="intel-card-meta">${escapeHtml(step.reason)}</div>`;
        html += `</div></div>`;
      }
    }
    html += `</div>`;

    intelMapResults.innerHTML = html;
    intelMapResults.classList.remove("hidden");
    results.classList.add("hidden");

    // Wire up intel map export buttons
    const intelCopyBtn = document.getElementById("intel-copy-btn");
    const intelExportBtn = document.getElementById("intel-export-btn");

    if (intelCopyBtn) {
      intelCopyBtn.addEventListener("click", async () => {
        if (!lastIntelMap) return;
        const content = buildIntelMapMarkdown(lastIntelMap);
        await navigator.clipboard.writeText(content);
        const textEl = document.getElementById("intel-copy-text");
        textEl.textContent = "Copied!";
        setTimeout(() => { textEl.textContent = "Copy"; }, 2000);
      });
    }

    if (intelExportBtn) {
      intelExportBtn.addEventListener("click", () => {
        if (!lastIntelMap) return;
        const content = buildIntelMapMarkdown(lastIntelMap);
        const blob = new Blob([content], { type: "text/markdown" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `intel-map-${slugify(lastIntelMap.companyName || "company")}.md`;
        a.click();
        URL.revokeObjectURL(url);
      });
    }
  }
});
