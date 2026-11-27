import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AdapterRegistry } from "../adapters/registry.js";
import { type BaselineFile } from "../brain/baseline.js";
import { runCrawl } from "../brain/crawler.js";
import { renderHtmlReport } from "../brain/report/html.js";
import { renderJsonReport } from "../brain/report/json.js";
import { renderMarkdownReport } from "../brain/report/markdown.js";
import { getProfile, hashConfig, loadConfigFile, profileToTargetDescriptor } from "../config.js";
import type { CrawlReport } from "../model/index.js";

/**
 * Executes a controlled crawl (`dpcrawl run`) and writes report.json, report.html, and bugs.md.
 */
export async function runCrawlCommand(params: {
  readonly configPath: string;
  readonly profileName: string;
  readonly registry: AdapterRegistry;
}): Promise<{ readonly report: CrawlReport; readonly outputDir: string }> {
  const config = await loadConfigFile(params.configPath);
  const profile = getProfile(config, params.profileName);
  const target = profileToTargetDescriptor(params.profileName, profile);
  const adapter = params.registry.require(target.adapter);

  let baseline: BaselineFile | undefined;
  if (profile.baselinePath !== undefined) {
    const rawBaseline = await readFile(profile.baselinePath, "utf8");
    baseline = JSON.parse(rawBaseline) as BaselineFile;
  }

  const report = await runCrawl({
    adapter,
    target,
    profile: params.profileName,
    configHash: hashConfig(profile),
    limits: profile.limits,
    confirmationMode: profile.confirmation,
    ...(baseline !== undefined ? { baseline } : {}),
  });

  const outputDir = profile.evidence.outputDir;
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDir, "report.json"), renderJsonReport(report), "utf8"),
    writeFile(path.join(outputDir, "report.html"), renderHtmlReport(report), "utf8"),
    writeFile(path.join(outputDir, "bugs.md"), renderMarkdownReport(report), "utf8"),
  ]);

  return { report, outputDir };
}
