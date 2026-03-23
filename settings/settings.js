document.addEventListener("DOMContentLoaded", async () => {
  const providerSelect = document.getElementById("provider-select");
  const modelSelect = document.getElementById("model-select");
  const apiKeyInput = document.getElementById("api-key");
  const apiKeyLabel = document.getElementById("api-key-label");
  const helpLink = document.getElementById("help-link");
  const saveBtn = document.getElementById("save-btn");
  const statusMsg = document.getElementById("status-msg");
  const toggleBtn = document.getElementById("toggle-key");

  // ── Provider config ────────────────────────────────────────────

  const PROVIDERS = {
    openai: {
      label: "OpenAI API Key",
      placeholder: "sk-...",
      helpUrl: "https://platform.openai.com/api-keys",
      helpLabel: "platform.openai.com",
      models: [
        { value: "gpt-5.4", label: "GPT-5.4 (Recommended)" },
        { value: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
        { value: "gpt-5.4-nano", label: "GPT-5.4 Nano" },
        { value: "gpt-4o", label: "GPT-4o" },
      ],
      validate: (key) => {
        if (!key) return "Please enter an API key.";
        if (!key.startsWith("sk-")) return "OpenAI keys start with 'sk-'.";
        return null;
      },
    },
    anthropic: {
      label: "Anthropic API Key",
      placeholder: "sk-ant-...",
      helpUrl: "https://console.anthropic.com/settings/keys",
      helpLabel: "console.anthropic.com",
      models: [
        { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Recommended)" },
        { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
        { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
        { value: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
      ],
      validate: (key) => {
        if (!key) return "Please enter an API key.";
        if (!key.startsWith("sk-ant-"))
          return "Anthropic keys start with 'sk-ant-'.";
        return null;
      },
    },
    google: {
      label: "Google AI API Key",
      placeholder: "AI...",
      helpUrl: "https://aistudio.google.com/apikey",
      helpLabel: "aistudio.google.com",
      models: [
        { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Recommended)" },
        { value: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
        { value: "gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite" },
        { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      ],
      validate: (key) => {
        if (!key) return "Please enter an API key.";
        return null;
      },
    },
  };

  // ── Load settings (with migration from old format) ─────────────

  const stored = await chrome.storage.local.get({
    provider: "",
    model: "",
    apiKeys: {},
    // Old keys for migration
    apiKey: "",
  });

  // Migrate from old sync storage format
  const syncStored = await chrome.storage.sync.get({ provider: "", model: "", apiKeys: {}, apiKey: "" });
  if (syncStored.apiKey || Object.keys(syncStored.apiKeys || {}).length > 0) {
    // Merge sync keys into local, preferring any already-local values
    for (const [k, v] of Object.entries(syncStored.apiKeys || {})) {
      if (!stored.apiKeys[k]) stored.apiKeys[k] = v;
    }
    if (syncStored.apiKey && !stored.apiKeys.openai) stored.apiKeys.openai = syncStored.apiKey;
    stored.provider = stored.provider || syncStored.provider || "openai";
    stored.model = stored.model || syncStored.model || "gpt-4o";
    await chrome.storage.local.set({ provider: stored.provider, model: stored.model, apiKeys: stored.apiKeys });
    // Remove keys from sync storage so they no longer propagate to other devices
    await chrome.storage.sync.remove(["provider", "model", "apiKeys", "apiKey"]);
  }

  // Migrate from old single-key format (local)
  if (stored.apiKey && !stored.apiKeys.openai) {
    stored.apiKeys.openai = stored.apiKey;
    stored.provider = stored.provider || "openai";
    stored.model = stored.model || "gpt-4o";
    await chrome.storage.local.set({
      provider: stored.provider,
      model: stored.model,
      apiKeys: stored.apiKeys,
    });
    await chrome.storage.local.remove("apiKey");
  }

  const currentProvider = stored.provider || "openai";
  const currentModel = stored.model || PROVIDERS[currentProvider].models[0].value;
  const apiKeys = stored.apiKeys || {};

  // ── Initialize UI ──────────────────────────────────────────────

  providerSelect.value = currentProvider;
  populateModels(currentProvider, currentModel);
  updateProviderUI(currentProvider);
  apiKeyInput.value = apiKeys[currentProvider] || "";

  // ── Provider change ────────────────────────────────────────────

  providerSelect.addEventListener("change", () => {
    const provider = providerSelect.value;
    populateModels(provider);
    updateProviderUI(provider);
    // Load saved key for this provider
    apiKeyInput.value = apiKeys[provider] || "";
    apiKeyInput.type = "password";
  });

  // ── Toggle API key visibility ──────────────────────────────────

  toggleBtn.addEventListener("click", () => {
    apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
  });

  // ── Save ───────────────────────────────────────────────────────

  saveBtn.addEventListener("click", async () => {
    const provider = providerSelect.value;
    const model = modelSelect.value;
    const key = apiKeyInput.value.trim();

    // Validate
    const error = PROVIDERS[provider].validate(key);
    if (error) {
      showStatus(error, "error");
      return;
    }

    // Update the key for this provider
    apiKeys[provider] = key;

    await chrome.storage.local.set({ provider, model, apiKeys });
    showStatus("Settings saved successfully.", "success");
  });

  // ── Helpers ────────────────────────────────────────────────────

  function populateModels(provider, selectedModel) {
    const models = PROVIDERS[provider].models;
    modelSelect.innerHTML = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.value;
      opt.textContent = m.label;
      modelSelect.appendChild(opt);
    }
    if (selectedModel) {
      modelSelect.value = selectedModel;
    }
  }

  function updateProviderUI(provider) {
    const config = PROVIDERS[provider];
    apiKeyLabel.textContent = config.label;
    apiKeyInput.placeholder = config.placeholder;
    helpLink.href = config.helpUrl;
    helpLink.textContent = config.helpLabel;
  }

  function showStatus(msg, type) {
    statusMsg.textContent = msg;
    statusMsg.className = `status ${type}`;
    statusMsg.classList.remove("hidden");
    setTimeout(() => statusMsg.classList.add("hidden"), 3000);
  }
});
