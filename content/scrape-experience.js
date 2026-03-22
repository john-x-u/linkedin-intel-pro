(() => {
  // Scrape the /details/experience/ page for the full work history
  async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function scrapeExperience() {
    // Scroll to load all items on the details page
    for (let i = 0; i < 20; i++) {
      window.scrollBy(0, 500);
      await sleep(250);
    }
    await sleep(1000);
    window.scrollTo(0, 0);

    const items = [];
    const listElements = document.querySelectorAll("li");

    for (const li of listElements) {
      const text = li.innerText.trim();
      if (!text || text.length < 10) continue;

      const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter(
          (l) =>
            l &&
            l !== "…see more" &&
            l !== "see more" &&
            !l.startsWith("Show ")
        );

      // Skip nav/sidebar items — experience items typically have 2+ lines
      if (lines.length < 2) continue;

      // Skip items that look like skill endorsements or other noise
      const joined = lines.join(" ");
      if (
        joined.includes("endorsement") ||
        joined.includes("Add profile section") ||
        joined.includes("Messaging") ||
        joined.length < 15
      )
        continue;

      items.push(lines.join(" | "));
    }

    // Deduplicate — nested li's may repeat parent content
    const unique = [];
    for (const item of items) {
      const isDuplicate = unique.some(
        (existing) => existing.includes(item) || item.includes(existing)
      );
      if (!isDuplicate) {
        unique.push(item);
      }
    }

    return unique;
  }

  return scrapeExperience();
})();
