(() => {
  try {
    function sleep(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }

    async function scrapePosts() {
      // Scroll to load more posts
      for (let i = 0; i < 8; i++) {
        window.scrollBy(0, 600);
        await sleep(300);
      }
      await sleep(1000);
      window.scrollTo(0, 0);

      const main = document.querySelector("main");
      if (!main) return [];

      // Use data-urn divs — each is one post with a unique activity URN
      const urnDivs = Array.from(main.querySelectorAll("[data-urn]"));
      if (urnDivs.length === 0) return [];

      const uiPatterns = [
        /^\d+ reactions?$/,
        /^\d+ comments?$/,
        /^\d+ reposts?$/,
        /^Like$/,
        /^Comment$/,
        /^Repost$/,
        /^Send$/,
        /^Follow$/,
        /^Join$/,
        /^…more$/,
        /^Visible to/,
        /^\d+[dwhmo]+\s*•/,
        /^\d+ (?:day|week|month|year)/,
        /^• \d/,
        /^Verified/,
        /^Premium/,
        /^Feed post number/,
        /^\d+$/,
      ];

      const originalPosts = [];

      for (const div of urnDivs) {
        const text = div.innerText.trim();

        // Skip reposts
        if (text.includes("reposted this")) continue;

        const urn = div.getAttribute("data-urn");
        const postUrl = urn
          ? `https://www.linkedin.com/feed/update/${urn}/`
          : "";

        const lines = text
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);

        if (lines.length < 3) continue;

        // Extract timestamp
        let timestamp = "";
        const timeMatch = text.match(
          /(\d+[dwhmo]+|(?:\d+ (?:day|week|month|year)s?))\s*•/
        );
        if (timeMatch) {
          timestamp = timeMatch[1];
        }

        // Extract post body — content starts after the timestamp line
        let contentStarted = false;
        const contentLines = [];

        for (const line of lines) {
          if (
            !contentStarted &&
            (/\d+[dwhmo]+\s*•/.test(line) ||
              /\d+ (?:day|week|month|year)/.test(line))
          ) {
            contentStarted = true;
            continue;
          }

          if (!contentStarted) continue;

          const isNoise = uiPatterns.some((p) => p.test(line));
          if (isNoise) continue;

          if (line.startsWith("https://") || line.startsWith("http://"))
            continue;

          contentLines.push(line);
        }

        const content = contentLines.join(" ").substring(0, 400);

        if (content.length > 20) {
          originalPosts.push({ timestamp, content, url: postUrl });
        }

        if (originalPosts.length >= 5) break;
      }

      return originalPosts;
    }

    return scrapePosts();
  } catch (e) {
    return [];
  }
})();
