import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

const FORBIDDEN_SPECIFIERS = [
  "adapters/",
  "enrichment/",
  "playwright",
  "electron",
  "flaui",
  "puppeteer",
  "selenium",
];

describe("Architecture boundaries", () => {
  it("prevents shared brain and model modules from importing adapters, enrichment, or platform drivers", () => {
    const root = process.cwd();
    const checkedFiles = [
      ...collectTsFiles(path.join(root, "src/brain")),
      ...collectTsFiles(path.join(root, "src/model")),
    ];

    expect(checkedFiles.length).toBeGreaterThan(0);

    for (const file of checkedFiles) {
      const content = readFileSync(file, "utf8");
      const importLines = content
        .split("\n")
        .filter((line) => /^\s*(import|export)\b/.test(line));

      for (const line of importLines) {
        const lower = line.toLowerCase();
        for (const forbidden of FORBIDDEN_SPECIFIERS) {
          expect(
            lower.includes(forbidden),
            `Forbidden import "${forbidden}" found in ${path.relative(root, file)}: ${line}`,
          ).toBe(false);
        }
      }
    }
  });
});
