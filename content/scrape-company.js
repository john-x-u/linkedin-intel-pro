(() => {
  try {
    function sleep(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }

    async function scrapeCompany() {
      // Light scroll to load lazy content
      for (let pos = 0; pos < 3000; pos += 400) {
        window.scrollTo(0, pos);
        await sleep(150);
      }
      await sleep(800);
      window.scrollTo(0, 0);

      const result = {
        companyName: "",
        companyUrl: window.location.href,
        description: "",
        industry: "",
        companySize: "",
        headquarters: "",
        specialties: "",
        website: "",
      };

      // Extract company name from <h1> or page title
      const h1 = document.querySelector("h1");
      if (h1) {
        result.companyName = h1.textContent.trim();
      } else {
        const titleMatch = document.title.match(
          /^(.+?)(?:\s*[:|-]\s*About)?(?:\s*[|]\s*LinkedIn)?$/
        );
        if (titleMatch) result.companyName = titleMatch[1].trim();
      }

      // Extract structured fields from <dt>/<dd> pairs
      const dts = document.querySelectorAll("dt");
      for (const dt of dts) {
        const label = dt.textContent.trim().toLowerCase();
        const dd = dt.nextElementSibling;
        if (!dd) continue;
        const value = dd.textContent.trim();

        if (label === "website") result.website = value;
        else if (label === "industry") result.industry = value;
        else if (label === "company size") result.companySize = value;
        else if (label === "headquarters") result.headquarters = value;
        else if (label === "specialties") result.specialties = value;
      }

      // Extract description from the Overview section
      const sections = Array.from(document.querySelectorAll("section"));
      const overviewSection = sections.find((s) => {
        const h = s.querySelector("h2, h3, [role='heading']");
        return h && h.textContent.trim().toLowerCase() === "overview";
      });

      if (overviewSection) {
        const lines = overviewSection.innerText
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        // Skip the "Overview" heading itself
        const descLines = lines.slice(1).filter(
          (l) =>
            l.toLowerCase() !== "overview" &&
            !l.startsWith("Show ") &&
            l !== "…see more" &&
            l !== "see more"
        );
        result.description = descLines.join(" ").substring(0, 500);
      }

      // Fallback: grab description from main text if Overview section not found
      if (!result.description) {
        const main = document.querySelector("main");
        if (main) {
          const text = main.innerText;
          // Look for a block of text that's likely the company description
          const lines = text
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 80);
          if (lines.length > 0) {
            result.description = lines[0].substring(0, 500);
          }
        }
      }

      return result;
    }

    return scrapeCompany();
  } catch (e) {
    return {
      companyName: "",
      companyUrl: window.location.href,
      description: "",
      industry: "",
      companySize: "",
      headquarters: "",
      specialties: "",
      website: "",
      error: e.message,
    };
  }
})();
