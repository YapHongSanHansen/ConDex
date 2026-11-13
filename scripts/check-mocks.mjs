// Lists every mock marker outside src/mocks/ so you know what to remove when connecting the backend.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SKIP = new Set(["node_modules", ".next", ".git", "mocks"]);
const PATTERNS = ["@mock-remove", "MOCK_"];
let hits = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(tsx?|mjs|css)$/.test(name)) scan(full);
  }
}
function scan(file) {
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (PATTERNS.some((p) => line.includes(p))) {
      hits++;
      console.log(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
    }
  });
}

walk(join(ROOT, "src"));
console.log(hits ? `\n${hits} hit(s) outside src/mocks/. Remove each @mock-remove-start/end block.` : "Clean: no mock markers outside src/mocks/.");
