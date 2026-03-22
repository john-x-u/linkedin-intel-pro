(() => {
  try {
    function sleep(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }

    async function scrapePeople() {
      // Scroll to load more people cards
      for (let i = 0; i < 10; i++) {
        window.scrollBy(0, 600);
        await sleep(300);
      }
      await sleep(1000);
      window.scrollTo(0, 0);

      const main = document.querySelector("main");
      if (!main) return [];

      const people = [];
      const seen = new Set();

      // Find all profile links (/in/slug)
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

        // Get the name — it's usually the link text or a nearby element
        const name = link.textContent.trim();
        if (!name || name.length < 2 || name.length > 80) continue;

        seen.add(profileUrl);

        // Walk up to the card container to find title and connection degree
        let card = link.closest("div");
        // Go up a few levels to find the full card
        for (let i = 0; i < 5 && card; i++) {
          if (card.innerText && card.innerText.includes(name)) {
            const text = card.innerText;
            // Check if this card has enough info (title, degree)
            if (text.includes("1st") || text.includes("2nd") || text.includes("3rd")) {
              break;
            }
          }
          card = card.parentElement;
        }

        let title = "";
        let connectionDegree = "";

        if (card) {
          const cardText = card.innerText;
          const lines = cardText
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);

          for (const line of lines) {
            // Connection degree
            if (!connectionDegree && /^\s*·?\s*(1st|2nd|3rd\+?)/.test(line)) {
              const m = line.match(/(1st|2nd|3rd\+?)/);
              if (m) connectionDegree = m[1];
            }

            // Title — typically the line after the name that isn't a degree or button
            if (
              !title &&
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
              title = line;
            }
          }
        }

        if (title) {
          people.push({ name, title, profileUrl, connectionDegree });
        }

        if (people.length >= 15) break;
      }

      return people;
    }

    return scrapePeople();
  } catch (e) {
    return [];
  }
})();
