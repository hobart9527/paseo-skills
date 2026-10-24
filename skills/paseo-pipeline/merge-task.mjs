#!/usr/bin/env node
import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Usage: node merge-task.mjs <branch> <task-id(s)> [review-result] [test-cmd]
// Examples:
//   node merge-task.mjs task/integer-set-partition-ops/T-04 T-04 "pass(mechanical)"
//   node merge-task.mjs pod/integer-set-partition-ops T-01,T-02,T-03 "pass(agent_profile_anchasi)" "npm test"

const branch = process.argv[2];
const taskIdsArg = process.argv[3];
const reviewResult = process.argv[4] || "pass(mechanical)";
const testCmd = process.argv[5] || (fs.existsSync("package.json") ? "npm test" : "true");

if (!branch || !taskIdsArg) {
  console.error("Usage: node merge-task.mjs <branch> <task-id(s)> [review-result] [test-cmd]");
  process.exit(1);
}

// Resolve change name from branch (pod/<name>, task/<name>/<task>, integration/<name>);
// fall back to the sole active change. Multiple active changes without a match: fail closed.
function findTasksFile() {
  const changesDir = path.join(process.cwd(), "openspec", "changes");
  if (!fs.existsSync(changesDir)) return null;
  const active = fs.readdirSync(changesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "archive" && fs.existsSync(path.join(changesDir, e.name, "tasks.md")))
    .map((e) => e.name);
  const fromBranch = branch.split("/")[1];
  if (fromBranch && active.includes(fromBranch)) return path.join(changesDir, fromBranch, "tasks.md");
  if (active.length === 1) return path.join(changesDir, active[0], "tasks.md");
  if (active.length > 1) {
    console.error(`[merge-task] Error: cannot resolve change from branch '${branch}' among [${active.join(", ")}]`);
    process.exit(30);
  }
  return null;
}

try {
  // 1. Check clean working directory
  const porcelain = execSync("git status --porcelain", { encoding: "utf8" }).trim();
  if (porcelain) {
    console.error("[merge-task] Error: Working tree is not clean before merge:\n" + porcelain);
    process.exit(1);
  }

  // 2. Capture pre-merge HEAD and target branch metadata
  const preHead = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  const taskSha = execSync(`git rev-parse --short "${branch}"`, { encoding: "utf8" }).trim();
  const commitSubject = execSync(`git log -1 --pretty=%s "${branch}"`, { encoding: "utf8" }).trim();

  // 3. Perform merge without committing
  try {
    execSync(`git merge --no-ff --no-commit "${branch}"`, { stdio: "pipe" });
  } catch (mergeErr) {
    console.error(`[merge-task] Error: Git merge failed for branch ${branch}`);
    try {
      execSync("git merge --abort", { stdio: "ignore" });
    } catch {
      execSync(`git reset --hard ${preHead}`, { stdio: "ignore" });
    }
    process.exit(10);
  }

  // 4. Run tests while in merged working tree
  const t0 = Date.now();
  try {
    execSync(testCmd, { stdio: "inherit" });
  } catch (testErr) {
    console.error(`[merge-task] Error: Test execution failed (${testCmd})`);
    try {
      execSync("git merge --abort", { stdio: "ignore" });
    } catch {
      execSync(`git reset --hard ${preHead}`, { stdio: "ignore" });
    }
    process.exit(20);
  }
  const testDuration = Date.now() - t0;

  // 5. Update tasks.md if present
  const tasksFile = findTasksFile();
  const targetTaskIds = taskIdsArg.split(",").map((s) => s.trim()).filter(Boolean);

  if (tasksFile && targetTaskIds.length > 0) {
    const content = fs.readFileSync(tasksFile, "utf8");
    const lines = content.split("\n");
    let modified = false;

    for (const tid of targetTaskIds) {
      const taskPattern = new RegExp(`^(\\s*-\\s*\\[)[ xX](\\]\\s*.*?\\b${tid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b(?!-).*)$`);
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(taskPattern);
        if (m) {
          lines[i] = `${m[1]}x${m[2]}`;
          modified = true;
          // Check if Done line already exists on next line
          if (i + 1 < lines.length && /^\s*-\s*Done:/.test(lines[i + 1])) {
            lines[i + 1] = `  - Done: merge=${taskSha} review=${reviewResult}`;
          } else {
            lines.splice(i + 1, 0, `  - Done: merge=${taskSha} review=${reviewResult}`);
          }
          break;
        }
      }
    }

    if (modified) {
      fs.writeFileSync(tasksFile, lines.join("\n"), "utf8");
      execSync(`git add "${tasksFile}"`);
    }
  }

  // 6. Complete atomic merge commit
  const taskList = targetTaskIds.join(",");
  const commitMsg = `merge(${taskList}): ${commitSubject}`;
  execFileSync("git", ["commit", "-m", commitMsg], { stdio: "inherit" });
  const mergeSha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();

  console.log(`[merge-task] Success: tasks=[${taskList}] branch=${branch} task_sha=${taskSha} merge_sha=${mergeSha} test_duration=${testDuration}ms`);
  process.exit(0);
} catch (err) {
  console.error(`[merge-task] Unexpected error: ${err.message}`);
  process.exit(1);
}
