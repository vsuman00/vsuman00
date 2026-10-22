#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const USERNAME = process.env.PROFILE_USERNAME?.trim() || "vsuman00";
const TOKEN =
  process.env.PROFILE_STATS_TOKEN?.trim() ||
  process.env.GITHUB_TOKEN?.trim() ||
  "";
const API_VERSION = "2022-11-28";
const GRAPHQL_URL = "https://api.github.com/graphql";
const INFO_COLUMNS = 58;
const YEARS_PER_QUERY = 8;
const EXCLUDED_LANGUAGES = new Set(["Jupyter Notebook"]);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const THEMES = {
  dark: {
    file: "assets/profile-card-dark.svg",
    header: "#58a6ff",
    rule: "#3d444d",
    key: "#ffa657",
    dots: "#484f58",
    value: "#c9d1d9",
    number: "#79c0ff",
    spark: "#39d353",
  },
  light: {
    file: "assets/profile-card-light.svg",
    header: "#0969da",
    rule: "#d0d7de",
    key: "#953800",
    dots: "#8c959f",
    value: "#24292f",
    number: "#0550ae",
    spark: "#2da44e",
  },
};

const MAIN_QUERY = `query($login:String!){
  user(login:$login){
    repositoriesContributedTo(contributionTypes:[COMMIT,PULL_REQUEST,REPOSITORY]){totalCount}
    pullRequests{totalCount}
    issues{totalCount}
    contributionsCollection{
      totalPullRequestReviewContributions
      restrictedContributionsCount
      contributionCalendar{
        totalContributions
        weeks{contributionDays{contributionCount}}
      }
    }
    repositories(first:100, ownerAffiliations:OWNER, orderBy:{field:STARGAZERS,direction:DESC}){
      totalCount
      pageInfo{hasNextPage endCursor}
      nodes{
        name
        isFork
        stargazerCount
        forkCount
        languages(first:8, orderBy:{field:SIZE,direction:DESC}){
          edges{size node{name}}
        }
      }
    }
  }
}`;

const MORE_REPOSITORIES_QUERY = `query($login:String!,$after:String!){
  user(login:$login){
    repositories(first:100, after:$after, ownerAffiliations:OWNER, orderBy:{field:STARGAZERS,direction:DESC}){
      pageInfo{hasNextPage endCursor}
      nodes{
        name
        isFork
        stargazerCount
        forkCount
        languages(first:8, orderBy:{field:SIZE,direction:DESC}){
          edges{size node{name}}
        }
      }
    }
  }
}`;

function yearsQuery(years) {
  const blocks = years
    .map(
      (year) =>
        `y${year}:contributionsCollection(from:"${year}-01-01T00:00:00Z",to:"${year}-12-31T23:59:59Z"){totalCommitContributions}`,
    )
    .join(" ");
  return `query($login:String!){user(login:$login){${blocks}}}`;
}

function splitYears(createdAt) {
  const first = new Date(createdAt).getUTCFullYear();
  const last = new Date().getUTCFullYear();
  const years = Array.from({ length: last - first + 1 }, (_, index) => first + index);
  const chunks = [];
  for (let index = 0; index < years.length; index += YEARS_PER_QUERY) {
    chunks.push(years.slice(index, index + YEARS_PER_QUERY));
  }
  return chunks;
}

async function githubJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "vsuman00-profile-card",
      "X-GitHub-Api-Version": API_VERSION,
      ...options.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API request failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

async function graphql(query, variables = { login: USERNAME }) {
  const payload = await githubJson(GRAPHQL_URL, {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  });
  if (payload.errors?.length) {
    throw new Error(`GitHub GraphQL error: ${payload.errors.map((error) => error.message).join("; ")}`);
  }
  return payload.data;
}

async function fetchAllRepositories(firstPage) {
  const repositories = [...firstPage.nodes];
  let pageInfo = firstPage.pageInfo;

  while (pageInfo.hasNextPage) {
    const data = await graphql(MORE_REPOSITORIES_QUERY, {
      login: USERNAME,
      after: pageInfo.endCursor,
    });
    const page = data.user?.repositories;
    if (!page) throw new Error(`GitHub user "${USERNAME}" was not returned while paging repositories.`);
    repositories.push(...page.nodes);
    pageInfo = page.pageInfo;
  }

  return repositories;
}

function aggregateLanguages(repositories) {
  const bytes = new Map();
  for (const repository of repositories) {
    if (repository.isFork) continue;
    for (const edge of repository.languages.edges) {
      const language = edge.node.name;
      if (EXCLUDED_LANGUAGES.has(language)) continue;
      bytes.set(language, (bytes.get(language) || 0) + edge.size);
    }
  }

  const total = [...bytes.values()].reduce((sum, size) => sum + size, 0);
  if (total === 0) return [];
  return [...bytes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, size]) => ({ name, share: size / total }));
}

async function fetchStats() {
  if (!TOKEN) {
    throw new Error("PROFILE_STATS_TOKEN is required to include private repository statistics.");
  }

  const profile = await githubJson(`https://api.github.com/users/${encodeURIComponent(USERNAME)}`);
  const yearChunks = splitYears(profile.created_at);
  const [main, ...yearResults] = await Promise.all([
    graphql(MAIN_QUERY),
    ...yearChunks.map((years) => graphql(yearsQuery(years))),
  ]);
  const user = main.user;
  if (!user) throw new Error(`GitHub user "${USERNAME}" was not found.`);

  const repositories = await fetchAllRepositories(user.repositories);
  const originalRepositories = repositories.filter((repository) => !repository.isFork);
  const calendar = user.contributionsCollection.contributionCalendar;
  const weeks = calendar.weeks.map((week) =>
    week.contributionDays.reduce((sum, day) => sum + day.contributionCount, 0),
  );
  const commits = yearResults.reduce((total, result) => {
    const collections = result.user || {};
    return (
      total +
      Object.values(collections).reduce(
        (subtotal, collection) => subtotal + (collection.totalCommitContributions || 0),
        0,
      )
    );
  }, 0);
  const topRepository = [...originalRepositories].sort(
    (a, b) => b.stargazerCount - a.stargazerCount || a.name.localeCompare(b.name),
  )[0];

  return {
    login: profile.login,
    createdAt: profile.created_at,
    location: cleanText(profile.location) || "Not set",
    company: cleanText(profile.company) || "Not set",
    website: cleanText(profile.blog) || "Not set",
    twitter: cleanText(profile.twitter_username),
    followers: profile.followers,
    repositoryCount: user.repositories.totalCount,
    stars: originalRepositories.reduce((sum, repository) => sum + repository.stargazerCount, 0),
    forks: originalRepositories.reduce((sum, repository) => sum + repository.forkCount, 0),
    commits,
    contributedTo: user.repositoriesContributedTo.totalCount,
    pullRequests: user.pullRequests.totalCount,
    issues: user.issues.totalCount,
    topRepository: topRepository
      ? { name: topRepository.name, stars: topRepository.stargazerCount }
      : null,
    languages: aggregateLanguages(repositories),
    lastYear: calendar.totalContributions,
    reviews: user.contributionsCollection.totalPullRequestReviewContributions,
    privateContributions: user.contributionsCollection.restrictedContributionsCount,
    weeks,
  };
}

function cleanText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(value, maximum) {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}

function accountUptime(createdAt, now = new Date()) {
  const created = new Date(createdAt);
  let years = now.getUTCFullYear() - created.getUTCFullYear();
  let months = now.getUTCMonth() - created.getUTCMonth();
  let days = now.getUTCDate() - created.getUTCDate();
  if (days < 0) {
    months -= 1;
    days += new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).getUTCDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  const parts = [];
  if (years > 0) parts.push(`${years} year${years === 1 ? "" : "s"}`);
  if (months > 0) parts.push(`${months} month${months === 1 ? "" : "s"}`);
  parts.push(`${days} day${days === 1 ? "" : "s"}`);
  return parts.join(", ");
}

function formatLanguages(languages, maximum) {
  const parts = languages
    .map(({ name, share }) => ({ name, percent: Math.round(share * 100) }))
    .filter(({ percent }) => percent >= 1)
    .slice(0, 5)
    .map(({ name, percent }) => `${name} ${percent}%`);
  while (parts.length > 1 && parts.join(", ").length > maximum) parts.pop();
  return parts.join(", ") || "No language data";
}

function sparkline(weeks) {
  const blocks = " ▁▂▃▄▅▆▇█";
  const recent = weeks.slice(-52);
  const maximum = Math.max(...recent, 1);
  return recent
    .map((count) => {
      if (count <= 0) return blocks[0];
      const level = 1 + Math.floor((Math.log1p(count) / Math.log1p(maximum)) * 7);
      return blocks[Math.max(1, Math.min(8, level))];
    })
    .join("");
}

function buildInfoLines(stats, colors) {
  const lines = [];
  const number = (value) => value.toLocaleString("en-US");

  const header = (label, y) => {
    const text = ` ${label} `;
    const fill = "─".repeat(Math.max(0, INFO_COLUMNS - text.length - 1));
    lines.push({
      y,
      spans: [
        ["─", colors.rule],
        [text, colors.header],
        [fill, colors.rule],
      ],
    });
  };

  const keyValue = (key, value, y, valueColor = colors.value) => {
    const finalValue = truncate(String(value), INFO_COLUMNS - key.length - 8);
    const dotCount = Math.max(2, INFO_COLUMNS - key.length - finalValue.length - 6);
    lines.push({
      y,
      spans: [
        [`. ${key}: `, colors.key],
        [".".repeat(dotCount), colors.dots],
        [` ${finalValue}`, valueColor],
      ],
    });
  };

  const keyValuePair = (key1, value1, key2, value2, y) => {
    const half = Math.floor((INFO_COLUMNS - 3) / 2);
    const part = (key, value) => {
      const finalValue = String(value);
      const dotCount = Math.max(2, half - key.length - finalValue.length - 6);
      return [
        [`. ${key}: `, colors.key],
        [".".repeat(dotCount), colors.dots],
        [` ${finalValue}`, colors.number],
      ];
    };
    lines.push({
      y,
      spans: [...part(key1, value1), [" | ", colors.rule], ...part(key2, value2)],
    });
  };

  header(`${stats.login}@github`, 111);
  keyValue("Uptime", accountUptime(stats.createdAt), 131);
  keyValue("Location", stats.location, 151);
  keyValue("Company", stats.company, 171);
  keyValue("Languages", formatLanguages(stats.languages, INFO_COLUMNS - 17), 191);

  header("Contact", 231);
  keyValue("Website", stats.website, 251);
  keyValue("Twitter", stats.twitter ? `@${stats.twitter}` : "Not set", 271);
  keyValue("GitHub", `github.com/${stats.login}`, 291);

  header("GitHub Stats", 331);
  keyValuePair("Repos", number(stats.repositoryCount), "Stars", number(stats.stars), 351);
  keyValuePair("Forks", number(stats.forks), "Followers", number(stats.followers), 371);
  keyValuePair("Commits", number(stats.commits), "Contributed", number(stats.contributedTo), 391);
  keyValuePair("PRs", number(stats.pullRequests), "Issues", number(stats.issues), 411);
  keyValue(
    "Top repo",
    stats.topRepository
      ? `${stats.topRepository.name} (${number(stats.topRepository.stars)} ★)`
      : "None",
    431,
  );

  header("Last 12 Months", 471);
  keyValuePair("Contributions", number(stats.lastYear), "Reviews", number(stats.reviews), 491);
  keyValue("Private", number(stats.privateContributions), 511, colors.number);
  lines.push({ y: 531, spans: [[`  ${sparkline(stats.weeks)}`, colors.spark]] });

  return lines;
}

function renderInfoLines(lines, x) {
  const attributes =
    `font-family="'Consolas', 'Menlo', 'DejaVu Sans Mono', monospace" ` +
    `xml:space="preserve" font-size="16"`;
  return lines
    .map(({ y, spans }) => {
      const content = spans
        .map(([text, color]) => `<tspan fill="${color}">${escapeXml(text)}</tspan>`)
        .join("");
      return `  <text x="${x}" y="${y}" ${attributes}>${content}</text>`;
    })
    .join("\n");
}

async function updateCard(theme, stats) {
  const colors = THEMES[theme];
  const file = join(ROOT, colors.file);
  const current = await readFile(file, "utf8");
  const headerMatch = current.match(/  <text x="([^"]+)" y="111"[^>]*>/);
  if (!headerMatch) throw new Error(`Could not find the profile data panel in ${colors.file}.`);

  const panelStart = headerMatch.index;
  const svgEnd = current.lastIndexOf("\n</svg>");
  if (svgEnd < panelStart) throw new Error(`Could not find the closing SVG tag in ${colors.file}.`);

  const panel = renderInfoLines(buildInfoLines(stats, colors), headerMatch[1]);
  const updated = `${current.slice(0, panelStart)}${panel}${current.slice(svgEnd)}`;
  if (updated === current) return false;

  const temporary = `${file}.tmp`;
  await writeFile(temporary, updated, "utf8");
  await rename(temporary, file);
  return true;
}

const stats = await fetchStats();
const results = await Promise.all(
  Object.keys(THEMES).map(async (theme) => [theme, await updateCard(theme, stats)]),
);
const changed = results.filter(([, didChange]) => didChange).map(([theme]) => theme);

console.log(
  changed.length > 0
    ? `Updated ${changed.join(" and ")} profile cards for @${stats.login}.`
    : `Profile cards for @${stats.login} are already current.`,
);
console.log(
  `Stats: ${stats.repositoryCount} repositories, ${stats.lastYear} contributions, ${stats.privateContributions} private contributions.`,
);
