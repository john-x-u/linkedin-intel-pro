/**
 * Background service worker — owns the full analysis lifecycle.
 *
 * Storage key: "analysisJob"
 *   { status: "idle" | "scraping" | "analyzing" | "done" | "error",
 *     profileData, projectDescription, result, error, timestamp }
 *
 * Supports three LLM providers: OpenAI, Anthropic, Google.
 */

// Open the side panel when the extension icon is clicked
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

const SYSTEM_PROMPT =
  "You are a professional networking analyst. You analyze LinkedIn profiles and provide structured insights about how a person's experience and skills could help someone achieve their goal — whether that's selling, hiring, fundraising, finding advisors, or building partnerships. Be specific and actionable. Use markdown formatting for your response.";

// ── Message listener ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "startAnalysis") {
    runAnalysis(message.tabId, message.projectDescription);
    sendResponse({ started: true });
    return false;
  }
  if (message.type === "getJobStatus") {
    chrome.storage.local.get({ analysisJob: null }, (data) => {
      sendResponse(data.analysisJob);
    });
    return true;
  }
  if (message.type === "clearJob") {
    chrome.storage.local.set({ analysisJob: { status: "idle" } });
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "startIntelMap") {
    runIntelMap(message.tabId, message.companyUrl, message.goal);
    sendResponse({ started: true });
    return false;
  }
  if (message.type === "getIntelJobStatus") {
    chrome.storage.local.get({ intelMapJob: null }, (data) => {
      sendResponse(data.intelMapJob);
    });
    return true;
  }
  if (message.type === "clearIntelJob") {
    chrome.storage.local.set({ intelMapJob: { status: "idle" } });
    sendResponse({ ok: true });
    return false;
  }
});

// ── Main analysis pipeline ─────────────────────────────────────────

async function runAnalysis(tabId, projectDescription) {
  try {
    // 1. Scrape
    await setJob({ status: "scraping", timestamp: Date.now() });

    const [{ result: profileData }] = await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/scrape.js"],
    });

    if (!profileData || !profileData.name) {
      throw new Error(
        "Could not read profile data. Make sure the full profile is loaded."
      );
    }

    // 2. Enrich — scrape company pages for current + previous employer
    let companyProfiles = [];
    const companiesToEnrich = getCompaniesToEnrich(profileData.experience || []);

    if (companiesToEnrich.length > 0) {
      await setJob({
        status: "enriching",
        profileData,
        projectDescription,
        timestamp: Date.now(),
      });

      const originalUrl = profileData.profileUrl;

      for (const entry of companiesToEnrich) {
        try {
          const aboutUrl = entry.companyUrl.replace(/\/$/, "") + "/about/";
          await chrome.tabs.update(tabId, { url: aboutUrl });
          const loaded = await waitForTabLoad(tabId, "/company/", 10000);
          if (!loaded) continue;

          // Extra wait for lazy content
          await sleep(1500);

          const [{ result: companyData }] = await chrome.scripting.executeScript(
            { target: { tabId }, files: ["content/scrape-company.js"] }
          );

          if (companyData && companyData.companyName) {
            companyProfiles.push(companyData);
          }
        } catch (e) {
          // Skip this company, continue with next
        }
      }

      // Navigate back to original profile
      try {
        await chrome.tabs.update(tabId, { url: originalUrl });
        await waitForTabLoad(tabId, "linkedin.com/in/", 10000);
      } catch (e) {
        // Best effort
      }
    }

    // 2b. Gather recent original posts for ice breakers
    let recentPosts = [];
    try {
      await setJob({
        status: "gathering_posts",
        profileData,
        projectDescription,
        timestamp: Date.now(),
      });

      const postsUrl =
        profileData.profileUrl.replace(/\/$/, "") + "/recent-activity/all/";
      await chrome.tabs.update(tabId, { url: postsUrl });
      const postsLoaded = await waitForTabLoad(
        tabId,
        "recent-activity",
        10000
      );

      if (postsLoaded) {
        await sleep(2000);

        const [{ result: posts }] = await chrome.scripting.executeScript({
          target: { tabId },
          files: ["content/scrape-posts.js"],
        });

        if (Array.isArray(posts) && posts.length > 0) {
          recentPosts = posts;
        }
      }

      // Navigate back to original profile
      try {
        await chrome.tabs.update(tabId, { url: profileData.profileUrl });
        await waitForTabLoad(tabId, "linkedin.com/in/", 10000);
      } catch (e) {
        // Best effort
      }
    } catch (e) {
      // Posts scraping is optional — continue without
    }

    // 2c. Scrape mutual connections if available
    let mutualConnections = [];
    if (profileData.mutualConnectionsUrl) {
      try {
        await setJob({
          status: "gathering_mutual",
          profileData,
          projectDescription,
          timestamp: Date.now(),
        });

        await chrome.tabs.update(tabId, {
          url: profileData.mutualConnectionsUrl,
        });
        const mutualLoaded = await waitForTabLoad(
          tabId,
          "search/results",
          10000
        );

        if (mutualLoaded) {
          await sleep(2000);

          const [{ result: mutuals }] =
            await chrome.scripting.executeScript({
              target: { tabId },
              files: ["content/scrape-mutual-connections.js"],
            });

          if (Array.isArray(mutuals) && mutuals.length > 0) {
            mutualConnections = mutuals;
          }
        }

        // Navigate back to original profile
        try {
          await chrome.tabs.update(tabId, { url: profileData.profileUrl });
          await waitForTabLoad(tabId, "linkedin.com/in/", 10000);
        } catch (e) {
          // Best effort
        }
      } catch (e) {
        // Mutual connections scraping is optional
      }
    }

    // 2d. Cross-reference with saved reports for Paths to Connect
    let pathsToConnect = null;
    try {
      pathsToConnect = await findPathsToConnect(
        profileData,
        mutualConnections
      );
    } catch (e) {
      // Non-critical — continue without
    }

    // 3. Analyze
    await setJob({
      status: "analyzing",
      profileData,
      projectDescription,
      timestamp: Date.now(),
    });

    const settings = await chrome.storage.sync.get({
      provider: "openai",
      model: "gpt-5.4",
      apiKeys: {},
      // Legacy migration fallback
      apiKey: "",
    });

    const provider = settings.provider || "openai";
    const model = settings.model || "gpt-5.4";
    let apiKey = (settings.apiKeys && settings.apiKeys[provider]) || "";

    // Legacy fallback
    if (!apiKey && provider === "openai" && settings.apiKey) {
      apiKey = settings.apiKey;
    }

    if (!apiKey) {
      throw new Error(
        `API key not configured for ${provider}. Please set it in the extension settings.`
      );
    }

    const prompt = buildPrompt(profileData, projectDescription, companyProfiles, recentPosts);
    const markdown = await callLLM(provider, model, apiKey, prompt);

    // 4. Done
    const report = {
      name: profileData.name,
      markdown,
      profileUrl: profileData.profileUrl,
      project: projectDescription,
      experience: profileData.experience || [],
      companies: companyProfiles,
      recentPosts,
      pathsToConnect,
      timestamp: Date.now(),
    };

    await setJob({ status: "done", result: report });
    await autoSaveReport(report);
  } catch (err) {
    await setJob({ status: "error", error: err.message });
  }
}

// ── Company enrichment helpers ─────────────────────────────────────

function getCompaniesToEnrich(experience) {
  const seen = new Set();
  const result = [];
  for (const entry of experience) {
    if (!entry.companyUrl || seen.has(entry.companyUrl)) continue;
    seen.add(entry.companyUrl);
    result.push(entry);
    if (result.length >= 2) break;
  }
  return result;
}

function waitForTabLoad(tabId, urlSubstring, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);

    function listener(updatedTabId, changeInfo, tab) {
      if (
        updatedTabId === tabId &&
        changeInfo.status === "complete" &&
        tab.url &&
        tab.url.includes(urlSubstring)
      ) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── LLM provider routing ───────────────────────────────────────────

async function callLLM(provider, model, apiKey, userPrompt) {
  switch (provider) {
    case "openai":
      return callOpenAI(model, apiKey, userPrompt);
    case "anthropic":
      return callAnthropic(model, apiKey, userPrompt);
    case "google":
      return callGoogle(model, apiKey, userPrompt);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// ── OpenAI ─────────────────────────────────────────────────────────

async function callOpenAI(model, apiKey, userPrompt) {
  const response = await fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.7,
        max_completion_tokens: 1500,
      }),
    }
  );

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// ── Anthropic ──────────────────────────────────────────────────────

async function callAnthropic(model, apiKey, userPrompt) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(
      err.error?.message || `Anthropic API error: ${response.status}`
    );
  }

  const data = await response.json();
  // Anthropic returns content as an array of blocks
  return data.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

// ── Google (Gemini) ────────────────────────────────────────────────

async function callGoogle(model, apiKey, userPrompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: userPrompt }],
        },
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1500,
      },
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(
      err.error?.message || `Google AI API error: ${response.status}`
    );
  }

  const data = await response.json();
  return data.candidates[0].content.parts.map((p) => p.text).join("\n");
}

// ── Utilities ──────────────────────────────────────────────────────

function setJob(job) {
  return chrome.storage.local.set({ analysisJob: job });
}

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
}

// ── Intel Map pipeline ─────────────────────────────────────────────

async function runIntelMap(tabId, companyUrl, goal) {
  try {
    // 1. Scrape company info
    await setIntelJob({ status: "intel_scraping_company", timestamp: Date.now() });

    const aboutUrl = companyUrl.replace(/\/$/, "").replace(/\/people\/?$/, "").replace(/\/about\/?$/, "") + "/about/";
    await chrome.tabs.update(tabId, { url: aboutUrl });
    await waitForTabLoad(tabId, "/company/", 10000);
    await sleep(1500);

    let companyData = {};
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content/scrape-company.js"],
      });
      if (result) companyData = result;
    } catch {}

    // 2. Scrape people
    await setIntelJob({ status: "intel_scraping_people", timestamp: Date.now() });

    const peopleUrl = companyUrl.replace(/\/$/, "").replace(/\/people\/?$/, "").replace(/\/about\/?$/, "") + "/people/";
    await chrome.tabs.update(tabId, { url: peopleUrl });
    await waitForTabLoad(tabId, "/people", 10000);
    await sleep(2000);

    let people = [];
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content/scrape-company-people.js"],
      });
      if (Array.isArray(result)) people = result;
    } catch {}

    // 3. Cross-reference with saved reports
    await setIntelJob({ status: "intel_cross_referencing", timestamp: Date.now() });

    const warmPaths = await findWarmPaths(companyData.companyName || "", people);

    // 4. LLM analysis
    await setIntelJob({ status: "intel_analyzing", timestamp: Date.now() });

    const settings = await chrome.storage.sync.get({
      provider: "openai",
      model: "gpt-5.4",
      apiKeys: {},
      apiKey: "",
    });

    const provider = settings.provider || "openai";
    const model = settings.model || "gpt-5.4";
    let apiKey = (settings.apiKeys && settings.apiKeys[provider]) || "";
    if (!apiKey && provider === "openai" && settings.apiKey) apiKey = settings.apiKey;

    if (!apiKey) {
      throw new Error(`API key not configured for ${provider}. Please set it in the extension settings.`);
    }

    const prompt = buildIntelMapPrompt(companyData, people, warmPaths, goal);
    const raw = await callLLM(provider, model, apiKey, prompt);

    // Parse JSON from LLM response
    let parsed;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch {
      parsed = {};
    }

    const result = {
      companyName: companyData.companyName || "Unknown Company",
      warmPaths,
      targetPeople: (parsed.targetPeople || []).map((tp) => ({
        ...tp,
        profileUrl: tp.profileUrl || people.find((p) => p.name === tp.name)?.profileUrl || "",
      })),
      approachSequence: parsed.approachSequence || [],
    };

    // Navigate back to company page
    try {
      await chrome.tabs.update(tabId, { url: companyUrl });
    } catch {}

    await setIntelJob({ status: "done", result });
    await autoSaveIntelMap(result, goal);
  } catch (err) {
    await setIntelJob({ status: "error", error: err.message });
  }
}

async function autoSaveIntelMap(result, goal) {
  if (!result || !result.companyName) return;

  const report = {
    type: "intel_map",
    name: result.companyName,
    project: goal,
    companyName: result.companyName,
    warmPaths: result.warmPaths,
    targetPeople: result.targetPeople,
    approachSequence: result.approachSequence,
    timestamp: Date.now(),
  };

  const { savedReports = [] } = await chrome.storage.local.get({ savedReports: [] });

  const idx = savedReports.findIndex(
    (r) => r.type === "intel_map" && r.companyName === result.companyName && r.project === goal
  );

  if (idx >= 0) {
    savedReports[idx] = report;
  } else {
    savedReports.unshift(report);
  }

  await chrome.storage.local.set({ savedReports });
}

function setIntelJob(job) {
  return chrome.storage.local.set({ intelMapJob: job });
}

async function findWarmPaths(companyName, people) {
  if (!companyName) return [];

  const { savedReports = [] } = await chrome.storage.local.get({ savedReports: [] });
  const warmPaths = [];
  const companyLower = companyName.toLowerCase();

  for (const report of savedReports) {
    if (!report.experience || !report.name) continue;

    // Check if any experience entry mentions this company
    for (const exp of report.experience) {
      const company = (typeof exp === "string" ? exp : exp.company || "").toLowerCase();
      if (company && companyLower.includes(company) || company.includes(companyLower)) {
        const date = report.timestamp
          ? new Date(report.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
          : "";
        warmPaths.push({
          name: report.name,
          connection: typeof exp === "string" ? exp : `${exp.title || ""} at ${exp.company || ""}`,
          analyzedDate: date,
          profileUrl: report.profileUrl || "",
        });
        break; // One match per saved report is enough
      }
    }
  }

  return warmPaths;
}

function buildIntelMapPrompt(company, people, warmPaths, goal) {
  const companyInfo = company.companyName
    ? `**${company.companyName}**\n* Industry: ${company.industry || "N/A"}\n* Size: ${company.companySize || "N/A"}\n* HQ: ${company.headquarters || "N/A"}\n* About: ${(company.description || "N/A").substring(0, 300)}`
    : "Company info not available";

  const peopleList = people.length > 0
    ? people.map((p) => `* ${p.name} — ${p.title} (${p.connectionDegree || "?"})`).join("\n")
    : "No people found";

  const warmPathsList = warmPaths.length > 0
    ? warmPaths.map((wp) => `* ${wp.name}: ${wp.connection} (analyzed ${wp.analyzedDate})`).join("\n")
    : "None";

  return `Given my goal and this target company, analyze these employees and my existing network connections to build an engagement strategy.

## My Goal
${goal}

## Target Company
${companyInfo}

## People at Company
${peopleList}

## My Existing Warm Paths (people I've previously analyzed who connect to this company)
${warmPathsList}

---

Analyze each person listed above and respond in this EXACT JSON format (no markdown, no code fences, just raw JSON):

{
  "targetPeople": [
    {
      "name": "exact name from list",
      "title": "their title",
      "role": "champion|decision_maker|evaluator|influencer|blocker|connector",
      "relevance": "one sentence on why they matter for my goal",
      "profileUrl": ""
    }
  ],
  "approachSequence": [
    {
      "step": 1,
      "type": "warm_intro|cold_outreach|internal_referral",
      "person": "name",
      "via": "name of warm path contact if warm_intro, empty otherwise",
      "action": "specific outreach approach in one sentence",
      "reason": "why this person and this order"
    }
  ]
}

Rules:
* targetPeople should include ALL people from the list, ranked by relevance to my goal
* Role must be one of: champion, decision_maker, evaluator, influencer, blocker, connector
* approachSequence should be ordered strategically — warm intros first, then cold outreach
* If warm paths exist, use them in the approach sequence
* Be specific in actions — reference the person's actual title and company context`;
}

// ── Paths to Connect ────────────────────────────────────────────────

async function findPathsToConnect(profileData, mutualConnections = []) {
  const { savedReports = [] } = await chrome.storage.local.get({
    savedReports: [],
  });

  // Only compare against profile-type saved reports (not intel maps, not self)
  const candidates = savedReports.filter(
    (r) =>
      r.type !== "intel_map" &&
      r.name &&
      r.experience &&
      r.name !== profileData.name
  );

  if (candidates.length === 0 && mutualConnections.length === 0) return null;

  const paths = {
    mutualConnections: [], // Real mutual connections from LinkedIn
    companyOverlaps: [], // People who worked at the same company
    industryCluster: [], // People in similar roles/industries
    companyBridges: [], // People you've analyzed at their current company
    introductionChains: [], // A->B->target chains
    networkStats: {
      totalAnalyzed: candidates.length,
      mutualCount: mutualConnections.length,
      topCompanies: {},
    },
  };

  // Extract target's companies and time ranges
  const targetCompanies = (profileData.experience || []).map((e) => ({
    company: (typeof e === "string" ? e : e.company || "").toLowerCase().trim(),
    title: typeof e === "string" ? "" : e.title || "",
    duration: typeof e === "string" ? "" : e.duration || "",
    isCurrent:
      typeof e === "string"
        ? false
        : (e.duration || "").toLowerCase().includes("present"),
  }));

  const targetCurrentCompany = targetCompanies.find((c) => c.isCurrent);

  for (const saved of candidates) {
    const savedExp = (saved.experience || []).map((e) => ({
      company: (typeof e === "string" ? e : e.company || "")
        .toLowerCase()
        .trim(),
      title: typeof e === "string" ? "" : e.title || "",
      duration: typeof e === "string" ? "" : e.duration || "",
      isCurrent:
        typeof e === "string"
          ? false
          : (e.duration || "").toLowerCase().includes("present"),
    }));

    const savedDate = saved.timestamp
      ? new Date(saved.timestamp).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        })
      : "";

    // 1. Company Overlaps — both worked at the same company
    for (const tc of targetCompanies) {
      if (!tc.company || tc.company.length < 2) continue;
      for (const sc of savedExp) {
        if (!sc.company || sc.company.length < 2) continue;
        if (
          tc.company.includes(sc.company) ||
          sc.company.includes(tc.company)
        ) {
          paths.companyOverlaps.push({
            savedName: saved.name,
            savedProfileUrl: saved.profileUrl || "",
            savedTitle: sc.title,
            savedDuration: sc.duration,
            targetTitle: tc.title,
            targetDuration: tc.duration,
            company: tc.company,
            analyzedDate: savedDate,
          });
        }
      }
    }

    // 2. Company Bridges — someone you analyzed currently works at target's current company
    if (targetCurrentCompany && targetCurrentCompany.company) {
      for (const sc of savedExp) {
        if (
          sc.isCurrent &&
          sc.company &&
          (sc.company.includes(targetCurrentCompany.company) ||
            targetCurrentCompany.company.includes(sc.company))
        ) {
          paths.companyBridges.push({
            savedName: saved.name,
            savedProfileUrl: saved.profileUrl || "",
            savedTitle: sc.title,
            company: targetCurrentCompany.company,
            analyzedDate: savedDate,
          });
        }
      }
    }

    // 3. Introduction Chains — saved person worked at a company where target currently works
    if (targetCurrentCompany && targetCurrentCompany.company) {
      for (const sc of savedExp) {
        if (
          !sc.isCurrent &&
          sc.company &&
          (sc.company.includes(targetCurrentCompany.company) ||
            targetCurrentCompany.company.includes(sc.company))
        ) {
          paths.introductionChains.push({
            savedName: saved.name,
            savedProfileUrl: saved.profileUrl || "",
            savedTitle: sc.title,
            savedDuration: sc.duration,
            targetCompany: targetCurrentCompany.company,
            analyzedDate: savedDate,
          });
        }
      }
    }

    // Track company frequency for stats
    for (const sc of savedExp) {
      if (sc.company && sc.company.length > 2) {
        const key = sc.company;
        paths.networkStats.topCompanies[key] =
          (paths.networkStats.topCompanies[key] || 0) + 1;
      }
    }
  }

  // Deduplicate
  paths.companyOverlaps = dedupeByKey(paths.companyOverlaps, "savedName");
  paths.companyBridges = dedupeByKey(paths.companyBridges, "savedName");
  paths.introductionChains = dedupeByKey(
    paths.introductionChains,
    "savedName"
  );

  // Remove intro chains that duplicate company bridges (same person)
  const bridgeNames = new Set(paths.companyBridges.map((b) => b.savedName));
  paths.introductionChains = paths.introductionChains.filter(
    (ic) => !bridgeNames.has(ic.savedName)
  );

  // Sort top companies
  const sortedCompanies = Object.entries(paths.networkStats.topCompanies)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  paths.networkStats.topCompanies = Object.fromEntries(sortedCompanies);

  // Process mutual connections — cross-reference with saved reports
  if (mutualConnections.length > 0) {
    const savedNames = new Set(candidates.map((c) => c.name.toLowerCase()));

    for (const mc of mutualConnections) {
      const isAnalyzed = savedNames.has(mc.name.toLowerCase());
      // Find saved report for this mutual connection
      const savedReport = isAnalyzed
        ? candidates.find(
            (c) => c.name.toLowerCase() === mc.name.toLowerCase()
          )
        : null;

      paths.mutualConnections.push({
        name: mc.name,
        title: mc.title || "",
        location: mc.location || "",
        profileUrl: mc.profileUrl || "",
        isAnalyzed,
        analyzedDate: savedReport?.timestamp
          ? new Date(savedReport.timestamp).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })
          : "",
      });
    }

    // Sort: analyzed connections first, then by name
    paths.mutualConnections.sort((a, b) => {
      if (a.isAnalyzed && !b.isAnalyzed) return -1;
      if (!a.isAnalyzed && b.isAnalyzed) return 1;
      return a.name.localeCompare(b.name);
    });
  }

  return paths;
}

function dedupeByKey(arr, key) {
  const seen = new Set();
  return arr.filter((item) => {
    if (seen.has(item[key])) return false;
    seen.add(item[key]);
    return true;
  });
}

// ── Prompt builder ─────────────────────────────────────────────────

function buildPrompt(profile, project, companies = [], posts = []) {
  const companyContext =
    companies.length > 0
      ? companies
          .filter((c) => c && c.companyName)
          .map((c) => {
            let block = `#### ${c.companyName}`;
            if (c.industry) block += `\n* Industry: ${c.industry}`;
            if (c.companySize) block += `\n* Size: ${c.companySize}`;
            if (c.headquarters) block += `\n* HQ: ${c.headquarters}`;
            if (c.specialties) block += `\n* Specialties: ${c.specialties}`;
            if (c.description) block += `\n* About: ${c.description}`;
            return block;
          })
          .join("\n\n")
      : "";

  return `Analyze this LinkedIn profile and explain how this person could professionally help me achieve my goal. My goal could be anything — selling a product, hiring, fundraising, finding advisors, building partnerships, or collaboration. Tailor your entire analysis to the specific goal described below.

## My Goal
${project}

## Profile: ${profile.name}
**Headline:** ${profile.headline}
**Location:** ${profile.location}

**About:**
${profile.about || "Not available"}

**Experience:**
${
  profile.experience.length > 0
    ? profile.experience
        .map((e) => {
          if (typeof e === "string") return `* ${e}`;
          let line = `* ${e.title}`;
          if (e.company) line += ` at ${e.company}`;
          if (e.duration) line += ` (${e.duration})`;
          if (e.description) line += `\n  ${e.description}`;
          return line;
        })
        .join("\n")
    : "Not available"
}

**Education:**
${
  profile.education.length > 0
    ? profile.education.map((e) => `* ${e}`).join("\n")
    : "Not available"
}

**Skills:**
${profile.skills.length > 0 ? profile.skills.join(", ") : "Not available"}

**Recommendations:**
${
  profile.recommendations.length > 0
    ? profile.recommendations.map((r) => `* ${r}`).join("\n")
    : "Not available"
}

${
  profile.fullProfileText
    ? `**Additional Profile Context:**\n${profile.fullProfileText}`
    : ""
}

${companyContext ? `**Company Context (current & recent employers):**\n\n${companyContext}` : ""}

${
  posts.length > 0
    ? `**Recent Original Posts (not reposts):**\n${posts.map((p, i) => `${i + 1}. [${p.timestamp}] ${p.content}\n   POST_URL: ${p.url || "N/A"}`).join("\n")}`
    : ""
}

---

IMPORTANT — First, read "My Goal" above and classify it into one of these categories (do not output this classification, just use it internally to adapt your entire analysis):
- **Selling**: pitching a product/service to this person or their company
- **Hiring/Recruiting**: evaluating this person as a potential hire or recruiting them
- **Fundraising**: seeking investment or financial support
- **Advisory**: looking for mentors, advisors, or domain experts
- **Partnership**: exploring strategic partnerships or collaborations
- **Research/Learning**: understanding an industry, role, or domain through this person's lens
- **Networking**: general relationship-building with no specific ask yet

Adapt ALL sections below to match this goal type. For example:
- If selling: frame angles as sales opportunities, consider their buying power and pain points
- If hiring: evaluate their fit, culture signals, and what would attract them
- If fundraising: assess their investment thesis alignment, portfolio, and network
- If advisory: focus on their domain depth and willingness to mentor
- If partnership: identify mutual value and complementary strengths
- If research/learning: highlight what unique insights they can share
- If networking: focus on long-term relationship value and shared interests

Provide your analysis in the following structured format (do NOT include a Work Experience section — that is handled separately). Use numbered lists (1. 2. 3.) for all items in every section below:

### Executive Profile Summary
Synthesize ALL the information above — profile, experience, company context, and recent posts — into exactly 3 numbered points tailored to MY SPECIFIC GOAL stated above. Imagine the reader has only 10 seconds. Each point should:
1. Directly address WHY this person matters for my specific goal (e.g., if I'm selling: their buying power; if hiring: their fit; if seeking advisors: their domain depth)
2. Reference specific details — actual roles, companies, numbers, or achievements (not generic statements)
3. Make the reader say "I need to talk to this person" in the context of my goal
Focus on: their relevance to my goal, current influence/decision-making power, and any unique positioning (rare skill combinations, strategic relationships, or industry timing) that makes them especially valuable for what I'm trying to accomplish.

### Relevant Skills & Experience
Identify which of their skills and past roles are most relevant to my goal. Be specific about how each applies.

### Strategic Engagement Angles
Based on my goal type, identify 3-5 specific, creative angles for engaging this person. Focus primarily on their experience from the LAST 2 YEARS (present role and any roles held within the past 2 years). If those recent roles provide sparse or limited detail, expand your analysis to include the last 5 years of experience. For each angle:
1. Reference a specific detail from their recent experience (current company initiatives, recent role responsibilities, a skill actively in use, their current industry context)
2. Frame the angle through the lens of my goal (e.g., if selling: how my offering solves their pain; if hiring: what about this opportunity would excite them; if fundraising: why this aligns with their investment interests; if advisory: what specific expertise I need from them)
3. Be concrete — reference actual roles, companies, and responsibilities. Don't say "they have relevant experience" — say exactly WHAT and HOW
4. Consider their seniority and position — tailor whether they're a decision-maker, influencer, evaluator, or connector relative to my goal
5. If Company Context is provided, use the company's industry, size, specialties, and description to craft more specific angles — especially when the person's own role descriptions are sparse

### Ice Breakers
Imagine I'm about to sit down in a meeting with this person. Based on their work history, current position, AND their recent original LinkedIn posts (if provided), suggest 4-5 specific topics or talking points I could naturally bring up to build rapport and naturally transition toward my goal. Prioritize topics from their recent posts — these reflect what they're actively thinking about and passionate about right now. For each topic:
* Reference the specific post, role detail, or career milestone that inspired it
* IMPORTANT: If referencing a LinkedIn post that has a POST_URL, you MUST include it as a markdown link at the end of that ice breaker, formatted as: [View Post](URL). This is critical so the reader can review the post before the meeting.
* Frame it as a natural conversation starter, not a scripted message
* Connect it back to my specific goal when possible
If no recent posts are available, base ice breakers on their work history and profile details instead.`;
}
