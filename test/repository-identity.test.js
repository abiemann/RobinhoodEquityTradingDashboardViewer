import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const REPOSITORY = "https://github.com/abiemann/RobinhoodEquityTradingDashboardViewer";
const PAGES = "https://abiemann.github.io/RobinhoodEquityTradingDashboardViewer/";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("public metadata uses the canonical repository and Pages identity", async () => {
  const [readme, about, privacy, terms, index, manifest, packageText] = await Promise.all([
    source("README.md"),
    source("about.html"),
    source("privacy.html"),
    source("terms.html"),
    source("index.html"),
    source("manifest.webmanifest"),
    source("package.json"),
  ]);
  const metadata = JSON.parse(packageText);
  const publishedText = [readme, about, privacy, terms, index, manifest, packageText].join("\n");

  assert.equal(metadata.name, "robinhood-equity-trading-dashboard-viewer");
  assert.equal(metadata.repository, `${REPOSITORY}.git`);
  assert.equal(metadata.homepage, PAGES);
  assert.equal(metadata.bugs.url, `${REPOSITORY}/issues`);
  assert.ok(readme.includes(REPOSITORY));
  assert.ok(readme.includes(PAGES));
  assert.ok(about.includes(`${REPOSITORY}/issues`));
  assert.ok(privacy.includes(`${REPOSITORY}/issues`));
  assert.ok(terms.includes(`${REPOSITORY}/issues`));
  assert.doesNotMatch(
    publishedText,
    /(?:github\.com\/abiemann|abiemann\.github\.io)\/RHMRA-Phone(?:\/|\b)/i,
  );
});
