# Changelog

## v1.4.0 — Intel Map: Org Chart, Deep People Scan & Prompt Improvements

### New Features

- **Interactive Org Chart** — Intel Map now infers and displays a hierarchical org chart with collapsible tree nodes, coverage indicators (green = 1st degree/warm path, yellow = 2nd degree, red = no path), and a coverage progress bar showing what percentage of the org is accessible
- **Tabbed Intel Map View** — Strategy and Org Chart are now split into switchable tabs for cleaner navigation
- **Multi-Pass Seniority Scraping** — Company people scraping now searches by seniority tier (Executive, C-Suite, VP, Director, Manager, Partner) to discover significantly more employees beyond the default page view
- **Org Chart Markdown Export** — Exported .md reports now include an ASCII-style org chart with coverage emoji indicators

### Improvements

- **Doubled Token Limits** — All LLM providers (OpenAI, Anthropic, Google) now use 8,000 max output tokens (up from 4,000) for richer analysis
- **Smarter Headline Interpretation** — LLM prompt now instructs the model to distinguish between LinkedIn headlines (personal taglines) and actual job titles, inferring real roles from context
- **LinkedIn Navigation Resilience** — Added retry logic when LinkedIn redirects /about/ to /posts/ or skips /people/ on small company pages
- **Company Name Fallback** — If the About page doesn't yield a company name, the people scraper extracts it from the page heading
- **Backward-Compatible People Format** — People scraper now returns `{ people, companyName }` while still handling the old plain-array format

### Bug Fixes

- Fixed company URL normalization to also strip `/posts/` suffix before constructing navigation URLs

## v1.3.0 — Profile Q&A Chat Drawer

- **Chat Drawer** — Slide-up drawer at the bottom of the analysis view for multi-turn Q&A about the analyzed profile
- **Full Context Injection** — First message includes complete profile analysis, experience, and posts as context for the LLM
- **Multi-Provider Support** — Chat works with all three providers (OpenAI, Anthropic, Google) including reasoning models
- **Typing Indicator** — Animated dots while waiting for LLM response
- **Markdown Rendering** — Assistant responses render with formatted markdown

## v1.2.0 — Cancel Analysis, Reasoning Models & Mutual Connection Enrichment

- Cancel button for in-progress analyses
- Reasoning model support (OpenAI o-series, Gemini thinking models)
- Mutual connection cross-referencing with saved reports
- Prompt optimizations for better output quality

## v1.1.0 — GPT-5.4 Compatibility & Security Hardening

- GPT-5.4 model compatibility
- Output formatting fixes
- Security hardening for content scripts

## v1.0.0 — Initial Release

- LinkedIn profile scraping and AI analysis
- Multi-provider LLM support (OpenAI, Anthropic, Google)
- Company enrichment and recent posts extraction
- Exportable markdown reports
