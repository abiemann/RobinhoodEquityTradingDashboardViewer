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
  assert.ok(readme.indexOf(PAGES) < readme.indexOf("## What the end user needs"));
  const endUserNeeds = readme.indexOf("## What the end user needs");
  const normalSetup = readme.indexOf("Normal setup starts on the laptop");
  assert.ok(normalSetup > 0);
  assert.ok(normalSetup < endUserNeeds);
  assert.doesNotMatch(readme.slice(0, endUserNeeds), /^\*\*Alternate setup:\*\*/m);
  assert.match(readme, /normal setup does not require the user to find or type a web address/);
  assert.match(
    readme,
    /1\. On the phone, open \[RHMRA Phone Dashboard\]\(https:\/\/abiemann\.github\.io\/RobinhoodEquityTradingDashboardViewer\/\)\./,
  );
  const recommendedQr = readme.indexOf("### Recommended: scan the QR code from the laptop dashboard");
  const alternateLink = readme.indexOf("### Alternate: install first and paste the private link");
  assert.ok(recommendedQr > 0);
  assert.ok(recommendedQr < alternateLink);
  assert.match(readme, /select \*\*View on Phone\*\*/);
  assert.match(readme, /select \*\*Pair phone and create QR code\*\*/);
  assert.match(readme, /The dashboard QR flow is the recommended approach/);
  assert.doesNotMatch(readme, /camera\/QR flow is still a convenient browser fallback/i);
  assert.match(readme, /View on Phone\*\* encodes a private pairing link in the QR code/);
  assert.match(readme, /Before releasing \*\*View on Phone\*\* QR pairing to end users/);
  assert.match(readme, /Copy private link\*\* as the documented alternate approach/);
  assert.match(readme, /complete link encoded in the laptop's \*\*View on Phone\*\* QR code/);
  assert.ok(about.includes(`${REPOSITORY}/issues`));
  assert.ok(privacy.includes(`${REPOSITORY}/issues`));
  assert.ok(terms.includes(`${REPOSITORY}/issues`));
  assert.doesNotMatch(
    publishedText,
    /(?:github\.com\/abiemann|abiemann\.github\.io)\/RHMRA-Phone(?:\/|\b)/i,
  );
});
