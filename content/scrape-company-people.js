(() => {
  try {
    function sleep(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }

    // Extract people cards currently visible on the page
    function extractVisiblePeople(seen, searchTier) {
      const main = document.querySelector("main");
      if (!main) return [];

      const people = [];
      const allLinks = Array.from(main.querySelectorAll("a"));

      for (const link of allLinks) {
        let pathname;
        try {
          pathname = new URL(link.href).pathname;
        } catch {
          continue;
        }

        if (!pathname.startsWith("/in/")) continue;

        const profileUrl = "https://www.linkedin.com" + pathname.replace(/\/$/, "");
        if (seen.has(profileUrl)) continue;

        const name = link.textContent.trim();
        if (!name || name.length < 2 || name.length > 80) continue;

        seen.add(profileUrl);

        // Walk up to the card container
        let card = link.closest("div");
        for (let i = 0; i < 5 && card; i++) {
          if (card.innerText && card.innerText.includes(name)) {
            const text = card.innerText;
            if (text.includes("1st") || text.includes("2nd") || text.includes("3rd")) {
              break;
            }
          }
          card = card.parentElement;
        }

        let headline = "";
        let connectionDegree = "";

        if (card) {
          const lines = card.innerText
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);

          for (const line of lines) {
            if (!connectionDegree && /^\s*·?\s*(1st|2nd|3rd\+?)/.test(line)) {
              const m = line.match(/(1st|2nd|3rd\+?)/);
              if (m) connectionDegree = m[1];
            }

            if (
              !headline &&
              line !== name &&
              !line.includes("Connect") &&
              !line.includes("Follow") &&
              !line.includes("Message") &&
              !line.includes("mutual connection") &&
              !/^(1st|2nd|3rd)/.test(line) &&
              !line.startsWith("·") &&
              line.length > 3 &&
              line.length < 120
            ) {
              headline = line;
            }
          }
        }

        if (headline) {
          people.push({
            name,
            title: headline,
            profileUrl,
            connectionDegree,
            searchTier,
          });
        }
      }

      return people;
    }

    async function typeInSearch(query) {
      // Find the search input on the people page
      const searchInput = document.querySelector(
        'input[placeholder*="Search employees"],' +
        'input[placeholder*="search employees"],' +
        'input[placeholder*="title, keyword"],' +
        'input[aria-label*="Search employees"],' +
        'input[aria-label*="search"]'
      );

      if (!searchInput) return false;

      // Clear existing search
      searchInput.focus();
      searchInput.value = "";
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      searchInput.dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(300);

      // Type the query
      searchInput.value = query;
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      searchInput.dispatchEvent(new Event("change", { bubbles: true }));

      // Press Enter to trigger search
      searchInput.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
      );
      searchInput.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
      );

      await sleep(2000); // Wait for results to load
      return true;
    }

    async function clearSearch() {
      const searchInput = document.querySelector(
        'input[placeholder*="Search employees"],' +
        'input[placeholder*="search employees"],' +
        'input[placeholder*="title, keyword"],' +
        'input[aria-label*="Search employees"],' +
        'input[aria-label*="search"]'
      );

      if (!searchInput) return;

      searchInput.focus();
      searchInput.value = "";
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      searchInput.dispatchEvent(new Event("change", { bubbles: true }));
      searchInput.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
      );
      searchInput.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
      );
      await sleep(1500);
    }

    async function scrollAndCollect(seen, searchTier) {
      // Scroll to load cards
      for (let i = 0; i < 8; i++) {
        window.scrollBy(0, 600);
        await sleep(300);
      }
      await sleep(800);
      window.scrollTo(0, 0);
      await sleep(300);

      return extractVisiblePeople(seen, searchTier);
    }

    async function scrapePeople() {
      const seen = new Set();
      const allPeople = [];

      // Get company name
      const companyName = (() => {
        const heading = document.querySelector("h1");
        if (heading) return heading.textContent.trim();
        return "";
      })();

      // Search tiers — ordered by seniority to build a top-down org chart
      const searchTiers = [
        { query: "CEO OR Founder OR President OR Managing Partner OR General Partner", tier: "executive" },
        { query: "Chief OR CTO OR CFO OR COO OR CRO OR CMO OR CPO", tier: "c-suite" },
        { query: "VP OR Vice President OR SVP OR EVP", tier: "vp" },
        { query: "Director OR Head of", tier: "director" },
        { query: "Manager OR Lead OR Principal", tier: "manager" },
        { query: "Partner OR Associate", tier: "partner" },
      ];

      // First: collect the default page (no search filter)
      const defaultPeople = await scrollAndCollect(seen, "default");
      allPeople.push(...defaultPeople);

      // Then: run targeted searches for each seniority tier
      for (const { query, tier } of searchTiers) {
        if (allPeople.length >= 60) break; // Cap total to keep LLM prompt manageable

        const searched = await typeInSearch(query);
        if (!searched) break; // No search box found, skip remaining

        const tierPeople = await scrollAndCollect(seen, tier);
        allPeople.push(...tierPeople);
      }

      // Clear search to leave the page clean
      await clearSearch();

      return { people: allPeople, companyName };
    }

    return scrapePeople();
  } catch (e) {
    return { people: [], companyName: "" };
  }
})();
