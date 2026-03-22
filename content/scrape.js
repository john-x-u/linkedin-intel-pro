(() => {
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function cleanLines(text) {
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  // Scroll the page to force lazy-loaded sections to render
  async function scrollToLoad() {
    window.scrollTo(0, 0);
    await sleep(300);
    const totalHeight = Math.max(document.body.scrollHeight, 5000);
    for (let pos = 0; pos < totalHeight; pos += 300) {
      window.scrollTo(0, pos);
      await sleep(200);
    }
    await sleep(1500);
    window.scrollTo(0, 0);
  }

  function getSectionMap() {
    const allSections = Array.from(document.querySelectorAll("section"));
    const map = {};
    for (const section of allSections) {
      const heading = section.querySelector("h2, h3, [role='heading']");
      if (heading) {
        map[heading.textContent.trim().toLowerCase()] = section;
      }
    }
    return map;
  }

  /**
   * Check if a line looks like a location string.
   * LinkedIn location lines follow patterns like:
   *   "San Diego, California, United States"
   *   "Orange County, California, United States · Remote"
   *   "Menlo Park, CA"
   *   "Remote"
   *   "New York, NY · Hybrid"
   */
  function looksLikeLocation(line) {
    // Must be relatively short (locations aren't long paragraphs)
    if (line.length > 100) return false;
    // Common patterns: "City, State", "City, State, Country", with optional " · Remote/Hybrid/On-site"
    if (/,\s*(United States|United Kingdom|Canada|Australia|India|Germany|France|Israel|Singapore|Ireland|Netherlands|Switzerland|Brazil|Japan|China|South Korea|Spain|Italy|Sweden|Norway|Denmark|Belgium|Austria|Finland|Poland|Mexico|New Zealand)/i.test(line)) return true;
    if (/,\s*[A-Z]{2}(\s*·|$)/.test(line)) return true; // "City, ST" US state abbreviation
    // Matches lines that are just work arrangement labels possibly with location
    if (/^(Remote|Hybrid|On-site)$/i.test(line)) return true;
    if (/·\s*(Remote|Hybrid|On-site)\s*$/i.test(line)) return true;
    return false;
  }

  /**
   * Extract structured experience entries from the Experience section.
   * LinkedIn renders each entry as a sibling <div> inside a container.
   * Each entry's innerText follows the pattern:
   *   Title\nCompany\nDuration\n[Description]\n[Skills]
   */
  function extractExperienceEntries(section) {
    const entries = [];

    // Duration pattern: matches things like "Sep 2024 - Present · 1 yr 7 mos"
    const durationRe =
      /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{4})\b.*(?:Present|\d{4})/;

    // Matches short total tenure strings like "13 yrs", "9 yrs 2 mos", "6 mos"
    const tenureOnlyRe = /^\d+\s+yrs?(?:\s+\d+\s+mos?)?$|^\d+\s+mos?$/;

    // Find all divs whose text looks like an experience entry
    // Strategy: walk all descendant divs and pick those whose first line
    // looks like a job title (not a heading, not "Show all", etc.)
    // We target the entry containers: direct children of the list wrapper.
    // The structure is: section > div > div (content) > div (entries container) > div (each entry)

    // First, get the raw section text to find entry boundaries
    const sectionText = section.innerText;
    const allLines = sectionText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    // Remove the "Experience" heading and "Show all" footer
    const contentLines = allLines.filter(
      (l) =>
        l.toLowerCase() !== "experience" &&
        !l.startsWith("Show all") &&
        l !== "… more" &&
        l !== "…see more" &&
        l !== "see more"
    );

    // Group lines into entries by detecting title + company + duration patterns.
    // Also detect grouped entries (multiple roles at the same company):
    // These appear as: CompanyName, TotalDuration, then Role1Title, Role1Duration, ...
    let current = null;
    let groupedCompany = null; // set when we detect a grouped company header

    for (let li = 0; li < contentLines.length; li++) {
      const line = contentLines[li];

      if (durationRe.test(line) || tenureOnlyRe.test(line)) {
        const isFullDuration = durationRe.test(line);
        const isTenureOnly = tenureOnlyRe.test(line);

        if (current && !current.duration) {
          // Duration/tenure right after title — check if this is a grouped company header.
          // A grouped header has: CompanyName (as title), then TotalDuration, then another
          // title+duration pair later. Peek ahead to see if there's another duration soon.
          let anotherDuration = false;
          for (let j = li + 1; j < Math.min(li + 8, contentLines.length); j++) {
            if (durationRe.test(contentLines[j])) {
              anotherDuration = true;
              break;
            }
          }
          if (anotherDuration && (isTenureOnly || anotherDuration)) {
            // This is a grouped company header — current.title is actually the company name
            groupedCompany = { name: current.title, totalTenure: line };
            current = null;
            continue;
          }
          if (isFullDuration) {
            // Normal case: duration for current entry
            current.duration = line;
          }
          // If tenure-only but no grouped header detected, skip it (metadata noise)
        } else if (current && current.duration && isFullDuration) {
          // Already have a duration — this could be a new entry's duration
          // (handled when we start a new entry below)
        } else if (!current) {
          // Duration without a current entry — skip
        }
      } else if (
        current &&
        current.duration &&
        !line.startsWith("\u25BD") &&
        !line.startsWith("◽")
      ) {
        // Lines after duration are description or skills
        if (line.includes("and +") && line.includes("skill")) {
          current.skills = line;
        } else if (line.startsWith("\u25BD") || line.match(/^[A-Z].*,.*and \+/)) {
          current.skills = line;
        } else {
          current.description = current.description
            ? current.description + " " + line
            : line;
        }
      } else if (!current || current.duration) {
        // New entry — this line is likely the title
        if (current) entries.push(current);
        current = { title: line, company: "", companyUrl: "", duration: "", description: "", skills: "" };
        // If we're inside a grouped company, assign the company name
        if (groupedCompany) {
          current.company = groupedCompany.name;
          current.totalTenure = groupedCompany.totalTenure;
        }
      } else if (current && !current.company) {
        current.company = line;
        // If this entry got its own company, it's not part of the grouped company
        if (groupedCompany && current.company !== groupedCompany.name) {
          groupedCompany = null;
          delete current.totalTenure;
        }
      } else if (current && !current.duration) {
        // Could be company continuation or other info
        // Check if it looks like a company (short, no date pattern)
        if (line.length < 80 && !durationRe.test(line)) {
          current.company = current.company
            ? current.company + " · " + line
            : line;
        }
      }

    }
    if (current) entries.push(current);

    return entries;
  }

  /**
   * Parse a grouped entry (multiple roles at the same company).
   * LinkedIn renders these with the company name + total tenure at the top,
   * followed by individual role entries nested inside.
   *
   * Returns an array of experience entries sharing the same company.
   */
  function parseGroupedEntry(lines, companyUrl, durationRe) {
    const entries = [];

    // Matches short total tenure strings like "13 yrs", "9 yrs 2 mos", "6 mos"
    const tenureOnlyRe = /^\d+\s+yrs?(?:\s+\d+\s+mos?)?$|^\d+\s+mos?$/;

    // First line is company name
    const companyName = lines[0] || "";
    let totalTenure = "";
    let roleStartIdx = 1;

    // Find the total tenure line in the first few lines.
    // It can be a full date range ("Jan 2016 - Feb 2025 · 9 yrs 2 mos")
    // or just a short tenure ("13 yrs", "9 yrs 2 mos").
    for (let i = 1; i < Math.min(lines.length, 4); i++) {
      if (durationRe.test(lines[i]) || tenureOnlyRe.test(lines[i])) {
        totalTenure = lines[i];
        roleStartIdx = i + 1;
        break;
      }
    }

    // Common metadata patterns that appear between company header and first role
    const metadataRe = /^(Full-time|Part-time|Contract|Freelance|Internship|Self-employed|Seasonal|Apprenticeship|Telecommute|Remote|Hybrid|On-site)$/i;

    // Skip metadata lines after total tenure (e.g. "Telecommute", "Full-time")
    // before the first actual role title.
    while (roleStartIdx < lines.length && metadataRe.test(lines[roleStartIdx])) {
      roleStartIdx++;
    }

    // First pass: identify role title indices by working backwards from each duration.
    // For each duration line, the role title is the first non-metadata line before it
    // (skipping over "Full-time", "Remote", etc. between title and duration).
    const roleTitleIndices = new Set();
    for (let i = roleStartIdx; i < lines.length; i++) {
      if (durationRe.test(lines[i])) {
        // Walk backwards to find the role title
        for (let j = i - 1; j >= roleStartIdx; j--) {
          if (metadataRe.test(lines[j])) continue; // skip metadata
          if (durationRe.test(lines[j])) break; // hit another duration, stop
          // Found the role title
          roleTitleIndices.add(j);
          break;
        }
      }
    }

    // Second pass: parse roles using the identified title positions.
    let current = null;
    for (let i = roleStartIdx; i < lines.length; i++) {
      const line = lines[i];

      if (roleTitleIndices.has(i)) {
        // Start a new role
        if (current) entries.push(current);
        current = {
          title: line,
          company: companyName,
          companyUrl,
          duration: "",
          location: "",
          description: "",
          totalTenure,
        };
      } else if (durationRe.test(line)) {
        // Duration line — attach to current role
        if (current && !current.duration) {
          current.duration = line;
        }
      } else if (current && current.duration) {
        // Description line (after the role's duration)
        if (line.includes("+") && line.includes("skill")) continue;
        if (line.length < 5) continue;
        if (metadataRe.test(line)) continue;
        // First line after duration is often a location
        if (!current.location && looksLikeLocation(line)) {
          current.location = line;
          continue;
        }
        current.description = current.description
          ? current.description + " " + line
          : line;
      }
      // Lines between title and duration (metadata) are skipped
    }
    if (current) entries.push(current);

    return entries;
  }

  /**
   * Extract structured experience/education entries from a section.
   * LinkedIn DOM structure: section > div > div > [heading_div, entries_div, hr, show_all_div]
   * Each entry is a direct child div of entries_div.
   */
  function extractExperienceFromDOM(section) {
    const entries = [];
    const durationRe =
      /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{4})\b.*(?:Present|\d{4})/;

    // Navigate the DOM tree to find the entries container
    // section > div.wrapper > div.content_panel > div.entries_container
    let entriesContainer = null;
    try {
      const wrapper = section.children[0];
      const contentPanel = wrapper.children[1] || wrapper.children[0];
      // The entries container is the child div that holds the actual entries
      // (not the heading div, not HR, not "Show all")
      for (const child of contentPanel.children) {
        if (child.tagName === "DIV" && child.children.length > 1) {
          const text = child.innerText.trim();
          // Skip the heading div and "Show all" div
          if (
            text.length > 50 &&
            !text.startsWith("Show all") &&
            durationRe.test(text)
          ) {
            entriesContainer = child;
            break;
          }
        }
      }
    } catch (e) {
      // Fall through to text-based fallback
    }

    if (entriesContainer) {
      // Each direct child div is an experience entry
      for (const entryDiv of entriesContainer.children) {
        if (entryDiv.tagName !== "DIV") continue;
        const text = entryDiv.innerText.trim();
        if (!text || text.length < 10) continue;

        const lines = text
          .split("\n")
          .map((l) => l.trim())
          .filter(
            (l) =>
              l &&
              l !== "… more" &&
              l !== "…see more" &&
              l !== "see more" &&
              !l.startsWith("Show ")
          );

        if (lines.length < 2) continue;

        // Extract company LinkedIn URL from <a> tags in this entry
        let companyUrl = "";
        const companyLink = entryDiv.querySelector('a[href*="/company/"]');
        if (companyLink) {
          try {
            const url = new URL(companyLink.href);
            companyUrl = url.origin + url.pathname.replace(/\/$/, "");
          } catch {}
        }

        // Detect grouped entry: multiple duration lines means multiple roles at one company
        const durationMatches = lines.filter((l) => durationRe.test(l));
        if (durationMatches.length >= 2) {
          const groupedEntries = parseGroupedEntry(lines, companyUrl, durationRe);
          for (const ge of groupedEntries) {
            if (ge.title && ge.title.length < 120) {
              entries.push(ge);
            }
          }
          continue;
        }

        // Single role entry — existing logic
        const entry = {
          title: lines[0] || "",
          company: "",
          companyUrl,
          duration: "",
          location: "",
          description: "",
        };

        for (let i = 1; i < lines.length; i++) {
          if (!entry.company && !durationRe.test(lines[i])) {
            entry.company = lines[i];
          } else if (!entry.duration && durationRe.test(lines[i])) {
            entry.duration = lines[i];
          } else if (entry.duration) {
            // Skip skills tags (e.g. "AI governance, Certified Information Privacy Professional and +10 skills")
            if (lines[i].includes("+") && lines[i].includes("skill")) continue;
            if (lines[i].length < 5) continue;
            // First line after duration is often a location (contains region/country patterns)
            if (!entry.location && looksLikeLocation(lines[i])) {
              entry.location = lines[i];
              continue;
            }
            entry.description = entry.description
              ? entry.description + " " + lines[i]
              : lines[i];
          }
        }

        if (entry.title && entry.title.length < 120) {
          entries.push(entry);
        }
      }
    }

    // Fallback: if DOM navigation didn't work, parse from section innerText
    if (entries.length === 0) {
      return extractExperienceEntries(section);
    }

    return entries;
  }

  async function scrapeProfile() {
    await scrollToLoad();

    const sectionMap = getSectionMap();

    // --- Intro ---
    const skip = [
      "about", "featured", "activity", "experience", "education",
      "skills", "recommendations", "interests", "licenses & certifications",
      "volunteering", "courses", "publications", "projects", "honors & awards",
      "languages", "organizations",
      "more profiles for you", "explore premium profiles",
      "people you may know", "you might like",
    ];
    const introKey = Object.keys(sectionMap).find(
      (k) =>
        k &&
        !skip.includes(k) &&
        !k.includes("notification") &&
        !k.includes("messaging")
    );
    const introSection = introKey ? sectionMap[introKey] : null;

    let name = "";
    let headline = "";
    let location = "";

    if (introSection) {
      const lines = cleanLines(introSection.innerText);
      name = lines[0] || "";
      headline = lines[1] || "";
      for (let i = 2; i < Math.min(lines.length, 8); i++) {
        if (
          lines[i].includes(",") &&
          !lines[i].includes("follower") &&
          !lines[i].includes("Followed by") &&
          lines[i].length < 100
        ) {
          location = lines[i];
          break;
        }
      }
    }
    if (!name) {
      const m = document.title.match(/^(.+?)(?:\s*[|–-]\s*LinkedIn)?$/);
      if (m) name = m[1].trim();
    }

    // --- About ---
    let about = "";
    if (sectionMap["about"]) {
      const lines = cleanLines(sectionMap["about"].innerText);
      about = lines
        .slice(1)
        .filter((l) => l !== "…see more" && l !== "see more")
        .join(" ");
    }

    // --- Experience ---
    let experience = [];
    if (sectionMap["experience"]) {
      experience = extractExperienceFromDOM(sectionMap["experience"]);
      // Fallback to text-based parsing if DOM approach fails
      if (experience.length === 0) {
        experience = extractExperienceEntries(sectionMap["experience"]);
      }
    }

    // --- Education ---
    let education = [];
    if (sectionMap["education"]) {
      education = extractExperienceFromDOM(sectionMap["education"]);
    }

    // --- Skills ---
    let skills = [];
    if (sectionMap["skills"]) {
      const lines = cleanLines(sectionMap["skills"].innerText);
      skills = [
        ...new Set(
          lines.filter(
            (l) =>
              l !== "Skills" &&
              !l.startsWith("Show all") &&
              !l.includes("endorsement") &&
              l.length < 80
          )
        ),
      ];
    }

    // --- Recommendations ---
    let recommendations = [];
    if (sectionMap["recommendations"]) {
      const lines = cleanLines(sectionMap["recommendations"].innerText);
      recommendations = lines
        .slice(1)
        .filter(
          (l) =>
            l !== "…see more" &&
            l !== "see more" &&
            !l.startsWith("Show all") &&
            l.length > 3
        )
        .slice(0, 10);
    }

    // --- Fallback full text ---
    const mainEl = document.querySelector("main");
    let fullProfileText = "";
    if (mainEl) {
      fullProfileText = cleanLines(mainEl.innerText).slice(0, 200).join("\n");
    }

    // --- Mutual connections link ---
    let mutualConnectionsUrl = "";
    let mutualConnectionsCount = 0;
    const allPageLinks = Array.from(document.querySelectorAll("a"));
    const mutualLink = allPageLinks.find((a) =>
      a.textContent.trim().toLowerCase().includes("mutual connection")
    );
    if (mutualLink) {
      mutualConnectionsUrl = mutualLink.href;
      const countMatch = mutualLink.textContent.match(
        /(\d+)\s*other\s*mutual/
      );
      if (countMatch) {
        // "X and Y other mutual connections" = Y + number of named people (usually 2)
        mutualConnectionsCount = parseInt(countMatch[1], 10) + 2;
      } else {
        const directMatch = mutualLink.textContent.match(
          /(\d+)\s*mutual/
        );
        if (directMatch) {
          mutualConnectionsCount = parseInt(directMatch[1], 10);
        } else {
          // Just names listed, count commas + 1
          mutualConnectionsCount = (mutualLink.textContent.match(/,/g) || []).length + 1;
        }
      }
    }

    return {
      name,
      headline,
      location,
      about,
      experience: experience.slice(0, 15),
      education: education.slice(0, 5),
      skills: skills.slice(0, 20),
      recommendations: recommendations.slice(0, 5),
      profileUrl: window.location.href,
      fullProfileText,
      mutualConnectionsUrl,
      mutualConnectionsCount,
    };
  }

  return scrapeProfile();
})();
