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
  const cancelBtn = document.getElementById("cancel-btn");

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
    hideChatDrawer();

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

      // Pre-flight: verify API key is configured before starting
      const settings = await chrome.storage.local.get({ provider: "openai", apiKeys: {}, apiKey: "" });
      const prov = settings.provider || "openai";
      const hasKey = (settings.apiKeys && settings.apiKeys[prov]) || (prov === "openai" && settings.apiKey);
      if (!hasKey) {
        throw new Error(
          `No API key saved for ${prov}. Open Settings (⚙) and click "Save Settings" after entering your key.`
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

  // ── Cancel button ──────────────────────────────────────────────────

  cancelBtn.addEventListener("click", async () => {
    stopPolling();
    await chrome.runtime.sendMessage({ type: "cancelAnalysis" });
    setLoading(false);
    hideError();
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

    let combined = `# LinkedIn Intel Pro — All Saved Research\n\n`;
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

    // Extract Connection Strategy from LLM output and move it into Paths to Connect
    let connectionStrategyHtml = "";
    const strategyRe = /<h3>Connection Strategy<\/h3>([\s\S]*?)(?=<h3>|$)/i;
    const strategyMatch = finalHtml.match(strategyRe);
    if (strategyMatch) {
      connectionStrategyHtml = strategyMatch[1].trim();
      finalHtml = finalHtml.replace(strategyMatch[0], "");
    }

    // Append Paths to Connect section at the end if available
    const pathsHtml = buildPathsToConnectHtml(report.pathsToConnect, connectionStrategyHtml);
    if (pathsHtml) {
      finalHtml += pathsHtml;
    }

    reportContent.innerHTML = finalHtml;

    // Bind expand/collapse toggle (inline onclick is blocked by CSP)
    const mutualHeader = reportContent.querySelector(".mutual-summary-header");
    if (mutualHeader) {
      mutualHeader.addEventListener("click", () => {
        mutualHeader.parentElement.classList.toggle("expanded");
      });
    }

    results.classList.remove("hidden");
    hideError();

    // Show chat drawer and reset conversation for new report
    resetChat();
    showChatDrawer();
  }

  function buildConnectionReasonsHtml(reasons) {
    if (!reasons || reasons.length === 0) return "";
    let html = '<div class="path-reasons">';
    const icons = {
      shared_company: "&#x1F3E2;",
      same_company: "&#x1F3E2;",
      role_overlap: "&#x1F4BC;",
      same_location: "&#x1F4CD;",
    };
    for (const r of reasons) {
      const icon = icons[r.type] || "&#x1F517;";
      html += `<span class="path-reason">${icon} ${escapeHtml(r.detail)}</span>`;
    }
    html += "</div>";
    return html;
  }

  function buildPathsToConnectHtml(paths, connectionStrategyHtml) {
    if (!paths) {
      // Show the section with an encouraging message even when no data yet
      return `<div class="paths-section"><h3>Paths to Connect</h3>
        <div class="path-stats"><div class="path-stats-label">Analyze more profiles to discover connections</div>
        <div class="path-stats-detail">As you analyze profiles, this section will automatically find shared companies, warm introductions, and connection paths across your network.</div></div></div>`;
    }

    let html = '<div class="paths-section"><h3>Paths to Connect</h3>';

    // 1. Connection Strategy (AI-generated, moved here from report body)
    if (connectionStrategyHtml) {
      html += `<div class="path-strategy-content">${connectionStrategyHtml}</div>`;
    }

    // 2. Mutual Connections — compact summary with expand toggle
    if (paths.mutualConnections && paths.mutualConnections.length > 0) {
      const analyzed = paths.mutualConnections.filter((mc) => mc.isAnalyzed);
      const notAnalyzed = paths.mutualConnections.filter((mc) => !mc.isAnalyzed);
      const totalCount = paths.networkStats?.mutualCount || paths.mutualConnections.length;
      const allMutuals = [...analyzed, ...notAnalyzed];

      // Build compact summary line
      const previewNames = allMutuals.slice(0, 3).map((mc) => {
        const name = escapeHtml(mc.name);
        return mc.isAnalyzed ? `<strong>${name}</strong>` : name;
      });
      const remaining = totalCount - previewNames.length;
      let summaryText = previewNames.join(", ");
      if (remaining > 0) summaryText += `, +${remaining} more`;

      html += '<div class="path-group">';
      const expandByDefault = !connectionStrategyHtml;
      html += `<div class="mutual-summary${expandByDefault ? " expanded" : ""}">`;
      html += '<div class="mutual-summary-header">';
      html += `<span class="path-group-label mutual-label">Mutual Connections (${totalCount})</span>`;
      html += `<span class="mutual-summary-names">${summaryText}</span>`;
      html += `<span class="mutual-expand-icon"></span>`;
      html += `</div>`;

      // Expandable detail cards
      html += '<div class="mutual-detail-list">';
      for (const mc of analyzed) {
        html += '<div class="path-card mutual-analyzed">';
        html += '<div class="path-icon">&#x2B50;</div>';
        html += '<div class="path-body">';
        html += `<div class="path-name"><a href="${escapeHtml(mc.profileUrl)}" target="_blank" rel="noopener">${escapeHtml(mc.name)}</a> <span class="analyzed-badge">Analyzed</span></div>`;
        html += `<div class="path-detail">${escapeHtml(mc.title)}</div>`;
        if (mc.location) html += `<div class="path-meta">${escapeHtml(mc.location)}</div>`;
        html += buildConnectionReasonsHtml(mc.connectionReasons);
        if (mc.analyzedDate) html += `<div class="path-date">Analyzed ${escapeHtml(mc.analyzedDate)}</div>`;
        html += '</div></div>';
      }
      for (const mc of notAnalyzed.slice(0, 5)) {
        html += '<div class="path-card">';
        html += '<div class="path-icon">&#x1F465;</div>';
        html += '<div class="path-body">';
        html += `<div class="path-name"><a href="${escapeHtml(mc.profileUrl)}" target="_blank" rel="noopener">${escapeHtml(mc.name)}</a></div>`;
        html += `<div class="path-detail">${escapeHtml(mc.title)}</div>`;
        if (mc.location) html += `<div class="path-meta">${escapeHtml(mc.location)}</div>`;
        html += buildConnectionReasonsHtml(mc.connectionReasons);
        html += '</div></div>';
      }
      if (notAnalyzed.length > 5) {
        html += `<div class="path-more">+ ${notAnalyzed.length - 5} more mutual connections</div>`;
      }
      html += '</div></div>'; // close mutual-detail-list, mutual-summary
      html += '</div>'; // close path-group
    }

    // 3. Company Overlaps
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

    // 4. Company Bridges
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

    // 5. Introduction Chains
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

    // 6. Network Stats
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

    // Extract Connection Strategy from LLM markdown and move it into Paths to Connect
    let connectionStrategyMd = "";
    const strategyMdRe = /### Connection Strategy\n([\s\S]*?)(?=\n### |$)/;
    const strategyMdMatch = finalMd.match(strategyMdRe);
    let cleanedMd = finalMd;
    if (strategyMdMatch) {
      connectionStrategyMd = strategyMdMatch[1].trim();
      cleanedMd = finalMd.replace(strategyMdMatch[0], "").trim();
    }

    const pathsMd = buildPathsToConnectMd(report.pathsToConnect, connectionStrategyMd);

    return `# LinkedIn Profile Analysis: ${report.name}

* **Profile:** ${report.profileUrl || "N/A"}
* **Goal:** ${report.project}
* **Generated:** ${date}

---

${cleanedMd}
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

    if (data.orgChart && data.orgChart.length > 0) {
      md += "\n### Org Chart\n\n";
      // Build tree for markdown export
      const nodeMap = new Map();
      for (const node of data.orgChart) {
        nodeMap.set(node.name, { ...node, children: [] });
      }
      const roots = [];
      for (const node of data.orgChart) {
        const treeNode = nodeMap.get(node.name);
        if (node.reportsTo && nodeMap.has(node.reportsTo)) {
          nodeMap.get(node.reportsTo).children.push(treeNode);
        } else {
          roots.push(treeNode);
        }
      }
      function renderMdTree(node, prefix, isLast) {
        const connector = prefix === "" ? "" : (isLast ? "└─ " : "├─ ");
        const coverageIcon = node.coverage === "direct" ? "🟢" : node.coverage === "indirect" ? "🟡" : "🔴";
        md += `${prefix}${connector}${coverageIcon} **${node.name}** — ${node.title || ""}`;
        if (node.department) md += ` (${node.department})`;
        md += "\n";
        const childPrefix = prefix === "" ? "" : prefix + (isLast ? "   " : "│  ");
        node.children.forEach((child, i) => {
          renderMdTree(child, childPrefix, i === node.children.length - 1);
        });
      }
      roots.forEach((root, i) => renderMdTree(root, "", i === roots.length - 1));
    }

    return md;
  }

  function buildPathsToConnectMd(paths, connectionStrategyMd) {
    if (!paths) return "";

    let md = "### Paths to Connect\n\n";

    // Connection Strategy (AI-generated, moved here)
    if (connectionStrategyMd) {
      md += `**Connection Strategy**\n${connectionStrategyMd}\n\n`;
    }

    // Compact mutual connections list
    if (paths.mutualConnections && paths.mutualConnections.length > 0) {
      const totalCount = paths.networkStats?.mutualCount || paths.mutualConnections.length;
      const analyzed = paths.mutualConnections.filter((mc) => mc.isAnalyzed);
      const notAnalyzed = paths.mutualConnections.filter((mc) => !mc.isAnalyzed);
      const allMutuals = [...analyzed, ...notAnalyzed];
      const names = allMutuals.map((mc) => mc.isAnalyzed ? `**${mc.name}**` : mc.name);
      md += `**Mutual Connections (${totalCount}):** ${names.join(", ")}\n\n`;
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
    // Sanitise: escape any raw HTML in the LLM output before converting
    // markdown syntax to HTML.  This prevents XSS via injected tags.
    md = md
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

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

    // Merge adjacent <ol> blocks separated by any non-heading content (e.g. <ul>,
    // <p>, links) into a single <ol> so numbering stays sequential (1,2,3 not 1,1,1).
    // Stop merging at headings (<h2>/<h3>) which indicate a new section.
    html = html.replace(
      /<\/ol>([\s\S]*?)<ol>/g,
      (match, middle) => {
        if (/<h[23]>/.test(middle)) return match; // new section — don't merge
        return middle;
      }
    );

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

      // Pre-flight: verify API key is configured before starting
      const intelSettings = await chrome.storage.local.get({ provider: "openai", apiKeys: {}, apiKey: "" });
      const intelProv = intelSettings.provider || "openai";
      const intelHasKey = (intelSettings.apiKeys && intelSettings.apiKeys[intelProv]) || (intelProv === "openai" && intelSettings.apiKey);
      if (!intelHasKey) {
        throw new Error(
          `No API key saved for ${intelProv}. Open Settings (⚙) and click "Save Settings" after entering your key.`
        );
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
      intel_scraping_people: "Deep-scanning org by seniority tier...",
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

  // ── Chat Drawer ──────────────────────────────────────────────────

  const chatDrawer = document.getElementById("chat-drawer");
  const chatToggle = document.getElementById("chat-toggle");
  const chatMessages = document.getElementById("chat-messages");
  const chatInput = document.getElementById("chat-input");
  const chatSendBtn = document.getElementById("chat-send-btn");

  let chatHistory = []; // [{role: "user"|"assistant", content: "..."}]
  let chatBusy = false;

  chatToggle.addEventListener("click", () => {
    chatDrawer.classList.toggle("open");
    if (chatDrawer.classList.contains("open")) {
      chatInput.focus();
    }
  });

  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  chatSendBtn.addEventListener("click", sendChatMessage);

  function showChatDrawer() {
    chatDrawer.classList.remove("hidden");
  }

  function hideChatDrawer() {
    chatDrawer.classList.add("hidden");
    chatDrawer.classList.remove("open");
  }

  function resetChat() {
    chatHistory = [];
    chatMessages.innerHTML = "";
  }

  function buildProfileContext(report) {
    let ctx = `Profile: ${report.name || "Unknown"}\n`;
    if (report.profileUrl) ctx += `URL: ${report.profileUrl}\n`;
    if (report.project) ctx += `Research Goal: ${report.project}\n`;
    ctx += `\n--- Analysis ---\n${report.markdown || ""}\n`;

    if (report.experience && report.experience.length > 0) {
      ctx += "\n--- Work Experience ---\n";
      for (const exp of report.experience) {
        if (typeof exp === "string") {
          ctx += `- ${exp}\n`;
        } else {
          ctx += `- ${exp.title || ""} at ${exp.company || ""} (${exp.duration || ""})\n`;
          if (exp.description) ctx += `  ${exp.description}\n`;
        }
      }
    }

    if (report.recentPosts && report.recentPosts.length > 0) {
      ctx += "\n--- Recent Posts ---\n";
      for (const post of report.recentPosts.slice(0, 5)) {
        ctx += `- ${post.content || post}\n`;
      }
    }

    return ctx;
  }

  async function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text || chatBusy) return;

    chatBusy = true;
    chatSendBtn.disabled = true;
    chatInput.value = "";

    // Build the user message — prepend profile context for the first message
    let userContent = text;
    if (chatHistory.length === 0 && lastReport.name) {
      const ctx = buildProfileContext(lastReport);
      userContent = `Here is the LinkedIn profile data:\n\n${ctx}\n\n---\n\nUser question: ${text}`;
    }

    chatHistory.push({ role: "user", content: userContent });

    // Show user bubble (display only the actual question)
    appendChatBubble("user", text);

    // Show typing indicator
    const typingEl = document.createElement("div");
    typingEl.className = "chat-typing";
    typingEl.innerHTML = '<div class="chat-typing-dot"></div><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div>';
    chatMessages.appendChild(typingEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    try {
      const response = await chrome.runtime.sendMessage({
        type: "chatMessage",
        messages: chatHistory,
      });

      typingEl.remove();

      if (response && response.error) {
        throw new Error(response.error);
      }

      const assistantText = response?.content || "Sorry, I couldn't get a response.";
      chatHistory.push({ role: "assistant", content: assistantText });
      appendChatBubble("assistant", assistantText);
    } catch (err) {
      typingEl.remove();
      const errEl = document.createElement("div");
      errEl.className = "chat-error";
      errEl.textContent = err.message || "Failed to get response";
      chatMessages.appendChild(errEl);
      // Remove failed user message from history so they can retry
      chatHistory.pop();
    }

    chatBusy = false;
    chatSendBtn.disabled = false;
    chatInput.focus();
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function appendChatBubble(role, text) {
    const bubble = document.createElement("div");
    bubble.className = `chat-msg ${role}`;
    if (role === "assistant") {
      bubble.innerHTML = markdownToHtml(text);
    } else {
      bubble.textContent = text;
    }
    chatMessages.appendChild(bubble);
    chatMessages.scrollTop = chatMessages.scrollHeight;
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

    // Tab bar — always show so users know org chart exists
    const hasOrgChart = data.orgChart && data.orgChart.length > 0;
    html += `<div class="intel-tab-bar">`;
    html += `<button class="intel-tab active" data-tab="strategy">Strategy</button>`;
    html += `<button class="intel-tab" data-tab="orgchart">Org Chart</button>`;
    html += `</div>`;

    // Strategy tab content
    html += `<div class="intel-tab-content active" id="intel-tab-strategy">`;

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

    html += `</div>`; // end strategy tab

    // Org Chart tab content
    html += `<div class="intel-tab-content" id="intel-tab-orgchart">`;
    if (hasOrgChart) {
      html += buildOrgChartHTML(data.orgChart, data.targetPeople);
    } else {
      html += `<div class="intel-empty">Org chart data was not returned. Try running the Intel Map again — the AI will infer the reporting structure from employee titles.</div>`;
    }
    html += `</div>`;

    intelMapResults.innerHTML = html;
    intelMapResults.classList.remove("hidden");
    results.classList.add("hidden");

    // Wire up tab switching
    const tabs = intelMapResults.querySelectorAll(".intel-tab");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        tabs.forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        const target = tab.getAttribute("data-tab");
        intelMapResults.querySelectorAll(".intel-tab-content").forEach((c) => c.classList.remove("active"));
        const targetEl = document.getElementById(`intel-tab-${target}`);
        if (targetEl) targetEl.classList.add("active");
      });
    });

    // Wire up org chart collapse/expand
    intelMapResults.querySelectorAll(".org-node-content.has-children").forEach((el) => {
      el.addEventListener("click", (e) => {
        // Don't toggle if clicking a link
        if (e.target.closest("a")) return;
        el.closest(".org-node").classList.toggle("collapsed");
      });
    });

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

  // ── Org Chart Builder ─────────────────────────────────────────

  function buildOrgChartHTML(orgChart, targetPeople) {
    if (!orgChart || orgChart.length === 0) return `<div class="intel-empty">No org chart data available.</div>`;

    // Build a lookup of name → node
    const nodeMap = new Map();
    for (const node of orgChart) {
      nodeMap.set(node.name, { ...node, children: [] });
    }

    // Build tree relationships
    const roots = [];
    for (const node of orgChart) {
      const treeNode = nodeMap.get(node.name);
      if (node.reportsTo && nodeMap.has(node.reportsTo)) {
        nodeMap.get(node.reportsTo).children.push(treeNode);
      } else {
        roots.push(treeNode);
      }
    }

    // Get role from targetPeople
    const roleMap = new Map();
    if (targetPeople) {
      for (const tp of targetPeople) {
        roleMap.set(tp.name, tp.role);
      }
    }

    // Coverage stats
    const total = orgChart.length;
    const accessible = orgChart.filter((n) => n.coverage === "direct" || n.coverage === "indirect").length;
    const pct = total > 0 ? Math.round((accessible / total) * 100) : 0;

    let html = "";

    // Coverage summary bar
    html += `<div class="org-coverage-bar">`;
    html += `<div class="org-coverage-label">${accessible}/${total} accessible (${pct}%)</div>`;
    html += `<div class="org-coverage-track"><div class="org-coverage-fill" style="width: ${pct}%"></div></div>`;
    html += `</div>`;

    // Legend
    html += `<div class="org-coverage-legend">`;
    html += `<div class="org-legend-item"><div class="coverage-dot direct"></div> 1st / Warm Path</div>`;
    html += `<div class="org-legend-item"><div class="coverage-dot indirect"></div> 2nd Degree</div>`;
    html += `<div class="org-legend-item"><div class="coverage-dot none"></div> No Path</div>`;
    html += `</div>`;

    // Render tree
    html += `<ul class="org-tree">`;
    for (const root of roots) {
      html += renderOrgNode(root, roleMap);
    }
    html += `</ul>`;

    return html;
  }

  function renderOrgNode(node, roleMap) {
    const hasChildren = node.children && node.children.length > 0;
    let html = `<li class="org-node">`;

    html += `<div class="org-node-content${hasChildren ? " has-children" : ""}">`;

    // Chevron for collapsible nodes
    if (hasChildren) {
      html += `<div class="org-node-chevron"></div>`;
    }

    // Coverage dot
    html += `<div class="coverage-dot ${escapeHtml(node.coverage || "none")}"></div>`;

    // Name (linked if profileUrl exists)
    if (node.profileUrl) {
      html += `<a href="${escapeHtml(node.profileUrl)}" target="_blank" rel="noopener" class="org-node-name">${escapeHtml(node.name)}</a>`;
    } else {
      html += `<span class="org-node-name">${escapeHtml(node.name)}</span>`;
    }

    // Title
    html += `<span class="org-node-title">${escapeHtml(node.title || "")}</span>`;

    // Role badge (from targetPeople)
    const role = roleMap.get(node.name);
    if (role) {
      const roleClass = role.replace(/[^a-z_]/g, "");
      html += `<span class="role-badge ${roleClass}">${escapeHtml(role)}</span>`;
    }

    html += `</div>`; // end org-node-content

    // Render children
    if (hasChildren) {
      html += `<ul>`;
      for (const child of node.children) {
        html += renderOrgNode(child, roleMap);
      }
      html += `</ul>`;
    }

    html += `</li>`;
    return html;
  }
});
