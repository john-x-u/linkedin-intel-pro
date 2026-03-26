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
  "You are a professional networking analyst. Analyze LinkedIn profiles and provide specific, actionable insights on how someone can help the user achieve their goal. Use markdown formatting.";

// ── Migrate API keys from sync → local (one-time) ─────────────────

async function migrateSettingsFromSync() {
  const local = await chrome.storage.local.get({ apiKeys: {}, provider: "", model: "" });
  if (local.provider && Object.keys(local.apiKeys).length > 0) return; // already migrated

  const sync = await chrome.storage.sync.get({ provider: "", model: "", apiKeys: {}, apiKey: "" });
  if (!sync.apiKey && Object.keys(sync.apiKeys || {}).length === 0) return; // nothing to migrate

  const apiKeys = { ...sync.apiKeys };
  if (sync.apiKey && !apiKeys.openai) apiKeys.openai = sync.apiKey;

  await chrome.storage.local.set({
    provider: sync.provider || "openai",
    model: sync.model || "gpt-5.4",
    apiKeys,
  });
  await chrome.storage.sync.remove(["provider", "model", "apiKeys", "apiKey"]);
}

migrateSettingsFromSync().catch(console.error);

let cancelled = false;

// ── Message listener ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "startAnalysis") {
    cancelled = false;
    runAnalysis(message.tabId, message.projectDescription);
    sendResponse({ started: true });
    return false;
  }
  if (message.type === "cancelAnalysis") {
    cancelled = true;
    chrome.storage.local.set({ analysisJob: { status: "idle" } });
    sendResponse({ ok: true });
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
  if (message.type === "chatMessage") {
    handleChatMessage(message.messages)
      .then((content) => sendResponse({ content }))
      .catch((err) => sendResponse({ error: err.message }));
    return true; // async sendResponse
  }
});

// ── Main analysis pipeline ─────────────────────────────────────────

function checkCancelled() {
  if (cancelled) throw new Error("__cancelled__");
}

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

    checkCancelled();

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

    checkCancelled();

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

    checkCancelled();

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

    checkCancelled();

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

    checkCancelled();

    // 3. Analyze
    await setJob({
      status: "analyzing",
      profileData,
      projectDescription,
      timestamp: Date.now(),
    });

    const settings = await chrome.storage.local.get({
      provider: "openai",
      model: "gpt-5.4",
      apiKeys: {},
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

    const pathsSummary = buildPathsSummaryForPrompt(pathsToConnect);
    const prompt = buildPrompt(profileData, projectDescription, companyProfiles, recentPosts, pathsSummary);
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
    if (err.message === "__cancelled__") return;
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
  const isReasoningModel = /^(o1|o3|o4)/.test(model);

  const body = {
    model,
    messages: [
      ...(isReasoningModel ? [] : [{ role: "system", content: SYSTEM_PROMPT }]),
      {
        role: isReasoningModel ? "developer" : "user",
        content: isReasoningModel ? SYSTEM_PROMPT + "\n\n" + userPrompt : userPrompt,
      },
    ],
  };

  if (isReasoningModel) {
    body.max_completion_tokens = 4000;
  } else {
    body.temperature = 0.7;
    body.max_tokens = 4000;
  }

  const response = await fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
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
      max_tokens: 4000,
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
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
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
        maxOutputTokens: 4000,
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

// ── Chat (multi-turn) ─────────────────────────────────────────────

const CHAT_SYSTEM_PROMPT =
  "You are a professional networking analyst. The user has analyzed a LinkedIn profile and wants to ask follow-up questions about it. Answer questions using the profile data provided in the conversation. Be specific, actionable, and concise. Use markdown formatting.";

async function handleChatMessage(messages) {
  const settings = await chrome.storage.local.get({
    provider: "openai",
    model: "gpt-5.4",
    apiKeys: {},
    apiKey: "",
  });

  const provider = settings.provider || "openai";
  const model = settings.model || "gpt-5.4";
  const apiKey =
    (settings.apiKeys && settings.apiKeys[provider]) ||
    (provider === "openai" ? settings.apiKey : "");

  if (!apiKey) {
    throw new Error(`No API key configured for ${provider}. Check Settings.`);
  }

  return callLLMChat(provider, model, apiKey, CHAT_SYSTEM_PROMPT, messages);
}

async function callLLMChat(provider, model, apiKey, systemPrompt, messages) {
  switch (provider) {
    case "openai":
      return callOpenAIChat(model, apiKey, systemPrompt, messages);
    case "anthropic":
      return callAnthropicChat(model, apiKey, systemPrompt, messages);
    case "google":
      return callGoogleChat(model, apiKey, systemPrompt, messages);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

async function callOpenAIChat(model, apiKey, systemPrompt, messages) {
  const isReasoningModel = /^(o1|o3|o4)/.test(model);

  const body = {
    model,
    messages: [
      ...(isReasoningModel
        ? [{ role: "developer", content: systemPrompt }]
        : [{ role: "system", content: systemPrompt }]),
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ],
  };

  if (isReasoningModel) {
    body.max_completion_tokens = 2000;
  } else {
    body.temperature = 0.7;
    body.max_tokens = 2000;
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

async function callAnthropicChat(model, apiKey, systemPrompt, messages) {
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
      max_tokens: 2000,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Anthropic API error: ${response.status}`);
  }

  const data = await response.json();
  return data.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function callGoogleChat(model, apiKey, systemPrompt, messages) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2000,
      },
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Google AI API error: ${response.status}`);
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

    const settings = await chrome.storage.local.get({
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

  return `Build an engagement strategy for this target company based on my goal, these employees, and my warm paths.

## My Goal
${goal}

## Target Company
${companyInfo}

## People at Company
${peopleList}

## Warm Paths (previously analyzed contacts who connect to this company)
${warmPathsList}

---

Respond in raw JSON only (no markdown, no code fences):

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
      "via": "warm path contact name if warm_intro, else empty",
      "action": "specific outreach approach referencing their title and context",
      "reason": "why this person and this order"
    }
  ]
}

Include ALL people ranked by relevance. Order approach sequence strategically: warm intros first, then cold outreach. Use warm paths when available.`;
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
  const targetLocation = (profileData.location || "").toLowerCase().trim();
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

      const connectionReasons = enrichMutualConnection(
        mc,
        savedReport,
        targetCompanies,
        targetCurrentCompany,
        targetLocation
      );

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
        connectionReasons,
      });
    }

    // Sort: analyzed first, then by number of reasons (most relevant first), then by name
    paths.mutualConnections.sort((a, b) => {
      if (a.isAnalyzed && !b.isAnalyzed) return -1;
      if (!a.isAnalyzed && b.isAnalyzed) return 1;
      const aReasons = (a.connectionReasons || []).length;
      const bReasons = (b.connectionReasons || []).length;
      if (bReasons !== aReasons) return bReasons - aReasons;
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

// ── Mutual connection enrichment ──────────────────────────────────

function parseCompanyFromTitle(title) {
  if (!title) return "";
  // LinkedIn titles: "Role at Company" or "Role @ Company"
  const atMatch = title.match(/\s+(?:at|@)\s+(.+)$/i);
  if (atMatch) return atMatch[1].trim().toLowerCase();
  // "Role - Company" (less common)
  const dashMatch = title.match(/\s+-\s+([^|]+)$/);
  if (dashMatch) return dashMatch[1].trim().toLowerCase();
  return "";
}

function extractTitleKeywords(title) {
  if (!title) return new Set();
  const roleWords = new Set([
    "engineer", "engineering", "developer", "product", "design", "designer",
    "marketing", "sales", "data", "science", "scientist", "manager", "director",
    "vp", "founder", "cto", "ceo", "coo", "cfo", "analyst", "consultant",
    "architect", "operations", "growth", "strategy", "ai", "ml", "software",
    "hardware", "research", "security", "devops", "infrastructure", "platform",
    "mobile", "frontend", "backend", "fullstack", "cloud", "finance", "legal",
    "hr", "recruiting", "partnerships", "business", "development",
  ]);
  const words = title.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/);
  return new Set(words.filter((w) => roleWords.has(w)));
}

function locationsOverlap(loc1, loc2) {
  if (!loc1 || !loc2) return false;
  const a = loc1.toLowerCase().replace(/[·]/g, ",");
  const b = loc2.toLowerCase().replace(/[·]/g, ",");
  // Split into parts (city, state, country)
  const partsA = a.split(",").map((s) => s.trim()).filter(Boolean);
  const partsB = b.split(",").map((s) => s.trim()).filter(Boolean);
  // Check if any meaningful part matches (skip very short tokens)
  for (const pa of partsA) {
    if (pa.length < 3) continue;
    for (const pb of partsB) {
      if (pb.length < 3) continue;
      if (pa.includes(pb) || pb.includes(pa)) return true;
    }
  }
  return false;
}

function enrichMutualConnection(mc, savedReport, targetCompanies, targetCurrentCompany, targetLocation) {
  const reasons = [];
  const mcLocation = (mc.location || "").toLowerCase().trim();
  const mcTitle = (mc.title || "").toLowerCase().trim();

  if (savedReport && savedReport.experience) {
    // Analyzed mutual: compare full experience
    const savedExp = (savedReport.experience || []).map((e) => ({
      company: (typeof e === "string" ? e : e.company || "").toLowerCase().trim(),
      title: typeof e === "string" ? "" : e.title || "",
      isCurrent: typeof e === "string" ? false : (e.duration || "").toLowerCase().includes("present"),
    }));

    // Shared companies
    const sharedCompanies = new Set();
    for (const tc of targetCompanies) {
      if (!tc.company || tc.company.length < 2) continue;
      for (const sc of savedExp) {
        if (!sc.company || sc.company.length < 2) continue;
        if (tc.company.includes(sc.company) || sc.company.includes(tc.company)) {
          const displayName = tc.company.length > sc.company.length ? tc.company : sc.company;
          sharedCompanies.add(displayName);
        }
      }
    }
    for (const company of sharedCompanies) {
      reasons.push({ type: "shared_company", detail: `Both worked at ${company}` });
    }

    // Bridge: mutual currently works at target's current company
    if (targetCurrentCompany && targetCurrentCompany.company) {
      for (const sc of savedExp) {
        if (sc.isCurrent && sc.company && (sc.company.includes(targetCurrentCompany.company) || targetCurrentCompany.company.includes(sc.company))) {
          if (!sharedCompanies.has(targetCurrentCompany.company)) {
            reasons.push({ type: "same_company", detail: `Currently works at ${targetCurrentCompany.company}` });
          }
          break;
        }
      }
    }

    // Role overlap
    const targetRoleKeywords = new Set();
    for (const tc of targetCompanies) {
      for (const kw of extractTitleKeywords(tc.title)) targetRoleKeywords.add(kw);
    }
    const savedRoleKeywords = new Set();
    for (const sc of savedExp) {
      for (const kw of extractTitleKeywords(sc.title)) savedRoleKeywords.add(kw);
    }
    const overlap = [...targetRoleKeywords].filter((kw) => savedRoleKeywords.has(kw));
    if (overlap.length > 0) {
      reasons.push({ type: "role_overlap", detail: `Both in ${overlap.slice(0, 3).join(", ")}` });
    }
  } else {
    // Non-analyzed: use title/location only
    const mcCompany = parseCompanyFromTitle(mc.title);
    if (mcCompany) {
      for (const tc of targetCompanies) {
        if (!tc.company || tc.company.length < 2) continue;
        if (tc.company.includes(mcCompany) || mcCompany.includes(tc.company)) {
          reasons.push({ type: "shared_company", detail: `Also connected to ${tc.company}` });
          break;
        }
      }
    }

    // Role overlap from title
    const targetRoleKeywords = new Set();
    for (const tc of targetCompanies) {
      for (const kw of extractTitleKeywords(tc.title)) targetRoleKeywords.add(kw);
    }
    const mcRoleKeywords = extractTitleKeywords(mc.title);
    const overlap = [...targetRoleKeywords].filter((kw) => mcRoleKeywords.has(kw));
    if (overlap.length > 0) {
      reasons.push({ type: "role_overlap", detail: `Both in ${overlap.slice(0, 3).join(", ")}` });
    }
  }

  // Geographic overlap (works for both analyzed and non-analyzed)
  if (locationsOverlap(mcLocation, targetLocation)) {
    // Extract a readable location snippet
    const parts = (mc.location || "").split(",").map((s) => s.trim()).filter(Boolean);
    const shortLoc = parts.slice(0, 2).join(", ");
    reasons.push({ type: "same_location", detail: shortLoc || mc.location });
  }

  return reasons;
}

// ── Paths summary for LLM prompt ──────────────────────────────────

function buildPathsSummaryForPrompt(pathsToConnect, maxEntries = 5) {
  if (!pathsToConnect) return "";

  const lines = [];
  let count = 0;

  // Mutual connections with reasons (most valuable)
  const enrichedMutuals = (pathsToConnect.mutualConnections || []).filter(
    (mc) => mc.connectionReasons && mc.connectionReasons.length > 0
  );
  for (const mc of enrichedMutuals) {
    if (count >= maxEntries) break;
    const reasons = mc.connectionReasons.map((r) => r.detail).join("; ");
    const tag = mc.isAnalyzed ? " [ANALYZED]" : "";
    lines.push(`- ${mc.name} (${mc.title})${tag} — ${reasons}`);
    count++;
  }

  // Mutual connections without reasons (still useful context)
  const plainMutuals = (pathsToConnect.mutualConnections || []).filter(
    (mc) => !mc.connectionReasons || mc.connectionReasons.length === 0
  );
  for (const mc of plainMutuals) {
    if (count >= maxEntries) break;
    const tag = mc.isAnalyzed ? " [ANALYZED]" : "";
    lines.push(`- ${mc.name} (${mc.title})${tag}`);
    count++;
  }

  // Company bridges
  for (const b of pathsToConnect.companyBridges || []) {
    if (count >= maxEntries) break;
    lines.push(`- [Company bridge] ${b.savedName} currently works at ${b.company} as ${b.savedTitle}`);
    count++;
  }

  // Company overlaps
  for (const o of pathsToConnect.companyOverlaps || []) {
    if (count >= maxEntries) break;
    lines.push(`- [Shared company] ${o.savedName} also worked at ${o.company}`);
    count++;
  }

  // Introduction chains
  for (const ic of pathsToConnect.introductionChains || []) {
    if (count >= maxEntries) break;
    lines.push(`- [Intro path] ${ic.savedName} previously worked at ${ic.targetCompany} as ${ic.savedTitle}`);
    count++;
  }

  if (lines.length === 0) {
    // Even without enrichment reasons, if there are mutual connections, include them
    const allMutuals = pathsToConnect.mutualConnections || [];
    if (allMutuals.length > 0) {
      for (const mc of allMutuals.slice(0, maxEntries)) {
        const tag = mc.isAnalyzed ? " [ANALYZED]" : "";
        lines.push(`- ${mc.name} (${mc.title})${tag}`);
      }
    }
  }

  if (lines.length === 0) return "";

  return `**Connection Paths to This Person:**\nYou have the following warm paths. Use these to recommend a connection strategy.\n${lines.join("\n")}`;
}

// ── Prompt builder ─────────────────────────────────────────────────

function buildPrompt(profile, project, companies = [], posts = [], pathsSummary = "") {
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

  return `Analyze this LinkedIn profile in relation to my goal. Adapt your entire analysis to the goal type (selling, hiring, fundraising, advisory, partnership, research, or networking).

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

${pathsSummary}

---

Respond with ONLY these ${pathsSummary ? "five" : "four"} sections. Use numbered lists. Never list or summarize job history (it's shown separately in the UI). Be specific throughout — reference actual roles, companies, achievements, and details rather than generic statements.

### Executive Profile Summary
Exactly 3 points synthesizing all info above. Each point must: address why this person matters for my specific goal, reference concrete details (roles, companies, numbers), and convey their unique value and influence.

### Relevant Skills & Experience
Which skills and past roles are most relevant to my goal, and specifically how each applies.

### Strategic Engagement Angles
3-5 specific angles for engaging this person, focused on their LAST 2 YEARS of experience (expand to 5 years if recent detail is sparse). Each angle must reference a specific detail from their experience, frame it through my goal, and account for their seniority/role (decision-maker, influencer, evaluator, or connector). Use Company Context when available to craft sharper angles.

### Ice Breakers
4-5 natural conversation starters drawn equally from their recent LinkedIn posts AND recent work experience (roles, projects, career milestones). Aim for a balanced mix — roughly half from posts and half from experience. Each should reference its source and connect back to my goal. If a post has a real POST_URL (not "N/A"), include it as: [View Post](URL). Do NOT generate a [View Post] link if the POST_URL is "N/A" or missing.${
  pathsSummary
    ? `

### Connection Strategy
Based on the Connection Paths above, recommend the best 1-2 warm introduction paths. For each, name the specific mutual connection or warm path, explain why they are the strongest bridge (shared company, role overlap, geography, etc.), and suggest a concrete ask or framing for the introduction. Keep it actionable and specific.`
    : ""
}`;
}
