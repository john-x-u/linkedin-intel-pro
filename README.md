# LinkedIn Intel Pro

[![Chrome Extension](https://img.shields.io/badge/Platform-Chrome%20Extension-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![JavaScript](https://img.shields.io/badge/JavaScript-Vanilla-F7DF1E?logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)

A Chrome extension that turns LinkedIn profiles and company pages into actionable intelligence. Get AI-powered analysis, strategic engagement plans, warm path discovery, and exportable reports — all from a side panel in your browser.

---

## Features

### Profile Analysis

- **AI-Powered Analysis** — Analyzes how someone's professional background maps to your specific goal (sales, hiring, fundraising, partnerships, etc.)
- **Deep Profile Scraping** — Automatically scrolls and extracts structured data: work experience, education, skills, about section, and recommendations
- **Company Enrichment** — Navigates to and scrapes company pages for up to 2 employers, adding industry, size, and description context to the analysis
- **Recent Posts** — Gathers original LinkedIn posts from the profile's activity feed for relevant ice breakers
- **Mutual Connections** — Scrapes mutual connections and cross-references them against your saved analyses to highlight people you've already researched
- **Paths to Connect** — Surfaces warm introduction routes by finding shared companies, company bridges, and potential introduction chains across your entire analyzed network
- **Ice Breakers** — Generates specific conversation starters based on their actual posts and career history, not generic templates

### Intel Map (Beta)

- **Company Intelligence** — Navigate to any LinkedIn company page and build a strategic engagement map
- **Warm Path Discovery** — Cross-references the company's employees against all your previously analyzed profiles to find people you already know
- **Target People Identification** — AI ranks company employees by relevance and assigns roles: Champion, Decision Maker, Evaluator, Influencer, Blocker, or Connector
- **Approach Sequence** — Generates an ordered engagement plan showing who to contact first, whether to use a warm intro or cold outreach, and specific actions for each step
- **Intel Map Export** — Copy to clipboard or download as `.md` file

### Export & History

- **Auto-Save** — Every completed analysis (profile or intel map) is automatically saved locally
- **Saved Reports Library** — Browse, reload, and manage all past analyses from the side panel
- **Markdown Export** — Download any individual report as a clean `.md` file
- **Bulk Download** — Export your entire research library as a single markdown file from the Saved Reports view
- **Copy to Clipboard** — One-click copy of any report's markdown content

### Multi-Provider AI Support

- **OpenAI** — GPT-5.4, GPT-5.4 Mini, GPT-5.4 Nano, GPT-4o
- **Anthropic** — Claude Sonnet 4.6, Claude Opus 4.6, Claude Haiku 4.5, Claude Sonnet 4.5
- **Google** — Gemini 3.1 Pro, Gemini 3.1 Flash, Gemini 3.1 Flash Lite, Gemini 2.5 Pro

---

## Setup

### Prerequisites

- **Google Chrome** (or any Chromium-based browser like Edge, Brave, Arc)
- An API key from at least one supported AI provider:
  - [OpenAI](https://platform.openai.com/api-keys)
  - [Anthropic](https://console.anthropic.com/settings/keys)
  - [Google AI Studio](https://aistudio.google.com/app/apikey)
- A LinkedIn account (you must be logged in for the extension to work)

### 1. Download the Extension

**Option A — Clone with Git:**

```bash
git clone https://github.com/john-x-u/linkedin-intel-pro.git
```

**Option B — Download ZIP:**

1. Go to [github.com/john-x-u/linkedin-intel-pro](https://github.com/john-x-u/linkedin-intel-pro)
2. Click the green **Code** button → **Download ZIP**
3. Unzip the downloaded file

### 2. Install in Chrome

1. Open `chrome://extensions/` in your browser
2. Enable **Developer mode** (toggle in the top right corner)
3. Click **Load unpacked**
4. Select the `linkedin-intel-pro` folder (the root folder containing `manifest.json`)
5. The extension icon will appear in your Chrome toolbar — pin it for easy access

### 3. Configure Your API Key

1. Click the extension icon in the toolbar — the side panel will open
2. Click the **gear icon** (⚙) in the top right corner to open Settings
3. Select your **AI Provider** (OpenAI, Anthropic, or Google)
4. Choose a **Model** from the dropdown — larger models produce better analysis but cost more per request
5. Enter your **API key**
6. Click **Save Settings**

Your API key is stored in Chrome's sync storage and will follow you across devices where you're signed into Chrome.

> **Tip:** If you're not sure which model to pick, start with a mid-tier option like GPT-5.4 Mini, Claude Sonnet 4.6, or Gemini 3.1 Flash — they offer a good balance of quality and cost.

---

## Usage

### Analyzing a LinkedIn Profile

1. **Navigate** to any LinkedIn profile page (`linkedin.com/in/...`)
2. **Open the side panel** by clicking the LinkedIn Intel Pro icon in your toolbar
3. **Describe your goal** in the text area — the more specific, the better:
   - *"Selling a cybersecurity platform to enterprise CISOs"*
   - *"Hiring a VP of Engineering for a Series B startup"*
   - *"Looking for advisors with AI/ML experience in healthcare"*
   - *"Exploring partnership opportunities in fintech"*
4. Click **Analyze Profile**
5. The extension will work through several stages (you'll see live status updates):
   - Scanning profile data
   - Researching companies
   - Gathering recent posts
   - Finding mutual connections
   - Analyzing with AI
6. When complete, your report includes:
   - **Executive Profile Summary** — 3 key points tailored to your goal
   - **Work Experience** — Full structured employment history
   - **Relevant Skills & Experience** — How their background maps to your needs
   - **Strategic Engagement Angles** — 3-5 specific approaches to consider
   - **Ice Breakers** — Conversation starters referencing their actual posts
   - **Paths to Connect** — Warm introductions, shared companies, network bridges

> **Note:** You can close the side panel during analysis — the background worker keeps running. Reopen it anytime to see results.

### Building an Intel Map

1. **Navigate** to any LinkedIn company page (`linkedin.com/company/...`)
2. The side panel will automatically show the **Build Intel Map** button
3. Enter your goal and click **Build Intel Map**
4. The extension will:
   - Scrape company details (industry, size, headquarters)
   - Scan employees from the company's people page
   - Cross-reference employees with your previously analyzed profiles to find warm paths
   - Generate a strategic engagement plan with AI
5. The result is a visual three-tier map:
   - **Warm Paths** — People from your network connected to this company
   - **Target People** — Key employees ranked by relevance with role badges (Champion, Decision Maker, Evaluator, Influencer, Blocker, Connector)
   - **Approach Sequence** — Step-by-step plan for who to contact and how

### Reviewing Saved Research

1. Click the **clock icon** (🕐) in the side panel header to open Saved Reports
2. Browse all previously analyzed profiles and intel maps
3. Click any item to reload and view the full report
4. Delete individual reports with the **×** button
5. Click **Download All .md** to export your entire research library as a single markdown file

### Exporting Reports

| Action | How |
|---|---|
| **Copy to clipboard** | Click the **Copy** button in the results header |
| **Download single report** | Click **Export .md** in the results header |
| **Download all reports** | Open Saved Reports → click **Download All .md** |

---

## Project Structure

```
linkedin-intel-pro/
├── manifest.json                    # Extension config (Manifest V3, side panel)
├── background/
│   └── background.js                # Service worker: analysis pipeline, LLM calls, autosave
├── popup/
│   ├── popup.html                   # Side panel UI
│   ├── popup.js                     # UI logic, display, export, polling
│   └── popup.css                    # Styling
├── content/
│   ├── scrape.js                    # Main profile scraper (experience, education, skills)
│   ├── scrape-experience.js         # Detailed experience page scraper
│   ├── scrape-company.js            # Company about page scraper
│   ├── scrape-company-people.js     # Company employees scraper
│   ├── scrape-posts.js              # Recent posts/activity scraper
│   └── scrape-mutual-connections.js # Mutual connections scraper
├── settings/
│   ├── settings.html                # Settings page
│   ├── settings.js                  # Provider/model/key management
│   └── settings.css                 # Settings styling
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Architecture

```
┌──────────────┐   startAnalysis    ┌─────────────────────┐
│  Side Panel  │ ─────────────────► │  Background Worker   │
│  (popup.js)  │ ◄── poll (800ms) ─ │  (background.js)     │
└──────────────┘                    └────────┬────────────┘
                                             │
                                    ┌────────▼────────────┐
                                    │ 1. Inject scraper    │
                                    │ 2. Enrich companies  │
                                    │ 3. Gather posts      │
                                    │ 4. Find mutuals      │
                                    │ 5. Call LLM API      │
                                    │ 6. Cross-ref network │
                                    │ 7. Autosave report   │
                                    └─────────────────────┘
```

- **Side panel** triggers analysis and polls for results — can be closed and reopened without losing progress
- **Background service worker** orchestrates the entire pipeline independently of the side panel lifecycle
- **Content scripts** run on LinkedIn pages to extract structured data via DOM traversal and auto-scrolling

## Permissions

| Permission | Purpose |
|---|---|
| `activeTab` | Access the current LinkedIn tab for scraping |
| `storage` | Persist API keys (sync) and saved reports (local) |
| `scripting` | Inject content scripts to scrape profile data |
| `tabs` | Detect active tab URL and navigate during enrichment |
| `sidePanel` | Display the extension UI as a Chrome side panel |
| `host_permissions: linkedin.com` | Required to run content scripts on LinkedIn |

## Tech Stack

- **Chrome Extension Manifest V3** with side panel UI
- **Vanilla JavaScript** — zero dependencies, no build step
- **Multi-provider LLM support** — OpenAI, Anthropic, Google Gemini
- **Chrome Storage API** — sync for settings, local for reports

---

## Contributing

Contributions are welcome! Here are some ways you can help:

- Report bugs or suggest features via [Issues](https://github.com/john-x-u/linkedin-intel-pro/issues)
- Submit pull requests for bug fixes or new features
- Improve the scraping logic for better LinkedIn compatibility
- Add support for additional LLM providers

### Development

1. Clone the repo and load it as an unpacked extension
2. Make changes to the source files
3. Click the refresh button on `chrome://extensions/` to reload
4. Test on a LinkedIn profile or company page

No build step required — edit and reload.

---

## Disclaimer

This extension is intended for personal productivity and professional networking purposes. It scrapes publicly visible LinkedIn profile data from the currently loaded page in your browser. It does not access LinkedIn's API, bypass authentication, or collect data in bulk.

Please use responsibly and in compliance with LinkedIn's [User Agreement](https://www.linkedin.com/legal/user-agreement) and applicable laws. The authors are not responsible for misuse of this tool.

This project is not affiliated with, endorsed by, or connected to LinkedIn Corporation, OpenAI, Anthropic, or Google.

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

Copyright (c) 2026 Spatial Ventures
