(() => {
  try {
    function sleep(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }

    async function scrapeMutualConnections() {
      // Scroll to load all results
      for (let i = 0; i < 8; i++) {
        window.scrollBy(0, 600);
        await sleep(300);
      }
      await sleep(1000);
      window.scrollTo(0, 0);

      const main = document.querySelector("main");
      if (!main) return [];

      const text = main.innerText;
      const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

      const people = [];
      let i = 0;

      while (i < lines.length) {
        // Detect a person entry: line ending with "• 1st" or next line is "• 1st"
        const degreeMatch = lines[i].match(/•\s*(1st|2nd|3rd\+?)\s*$/);
        const nextDegreeMatch =
          i + 1 < lines.length
            ? lines[i + 1].match(/^•\s*(1st|2nd|3rd\+?)$/)
            : null;

        if (degreeMatch || nextDegreeMatch) {
          let name, degree;

          if (degreeMatch) {
            // Name and degree on same line: "Omid Ghiam • 1st"
            name = lines[i].replace(/\s*•\s*(1st|2nd|3rd\+?)\s*$/, "").trim();
            degree = degreeMatch[1];
            i++;
          } else {
            // Name on one line, degree on next: "Michael Osofsky\n• 1st"
            name = lines[i].trim();
            degree = nextDegreeMatch[1];
            i += 2;
          }

          if (!name || name.length < 2 || name.length > 80) continue;

          // Next line(s) are title, then location
          let title = "";
          let location = "";

          // Read title — skip noise lines
          while (i < lines.length) {
            const line = lines[i];
            if (isNoise(line) || isDegree(line)) {
              i++;
              continue;
            }
            title = line;
            i++;
            break;
          }

          // Read location (optional — contains comma or "Area")
          while (i < lines.length) {
            const line = lines[i];
            if (isNoise(line)) {
              i++;
              continue;
            }
            if (
              line.includes(",") ||
              line.includes("Area") ||
              line.includes("United States") ||
              line.includes("Metropolitan")
            ) {
              location = line;
              i++;
            }
            break;
          }

          // Skip remaining lines for this entry (Message, followers, mutual connections text)
          while (i < lines.length) {
            const line = lines[i];
            if (
              line === "Message" ||
              line === "Connect" ||
              line === "Follow" ||
              line.includes("mutual connection") ||
              line.includes("follower") ||
              line === "Pending"
            ) {
              i++;
              continue;
            }
            break;
          }

          if (title) {
            people.push({ name, title, location, degree });
          }
        } else {
          i++;
        }
      }

      // Now get profile URLs by matching names to links
      const allLinks = Array.from(main.querySelectorAll("a"));
      const nameToUrl = {};
      for (const link of allLinks) {
        let pathname;
        try {
          pathname = new URL(link.href).pathname;
        } catch {
          continue;
        }
        if (!pathname.startsWith("/in/")) continue;
        const linkName = link.textContent.trim();
        if (linkName && linkName.length > 1) {
          nameToUrl[linkName] =
            "https://www.linkedin.com" + pathname.replace(/\/$/, "");
        }
      }

      // Attach URLs to people
      for (const person of people) {
        person.profileUrl = nameToUrl[person.name] || "";
        // Try partial match if exact fails
        if (!person.profileUrl) {
          for (const [linkName, url] of Object.entries(nameToUrl)) {
            if (
              linkName.includes(person.name) ||
              person.name.includes(linkName)
            ) {
              person.profileUrl = url;
              break;
            }
          }
        }
      }

      return people;
    }

    function isNoise(line) {
      return (
        line === "Message" ||
        line === "Connect" ||
        line === "Follow" ||
        line === "Pending" ||
        line.includes("mutual connection") ||
        line.includes("follower") ||
        line.includes("Are these results helpful")
      );
    }

    function isDegree(line) {
      return /^•?\s*(1st|2nd|3rd\+?)$/.test(line);
    }

    return scrapeMutualConnections();
  } catch (e) {
    return [];
  }
})();
