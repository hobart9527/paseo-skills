# Paseo Skills

Production-grade agent skills for autonomous engineering delivery, multi-agent pipeline orchestration, and frontend UI/UX engineering.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 📦 What's Included

| Skill | Directory | Description | Trigger |
| :--- | :--- | :--- | :--- |
| **Paseo Pipeline** | [`skills/paseo-pipeline`](skills/paseo-pipeline) | Industrial multi-agent engineering delivery pipeline. Integrates OpenSpec lifecycle, declarative contract gates, and automated merge verification. | `/paseo-pipeline`, 流水线交付 |
| **Paseo UI (2.0)** | [`skills/paseo-ui`](skills/paseo-ui) | AI-Native frontend and UI/UX industrial delivery pipeline. Features dual-mode execution (7 Lite fast-paths + 6-stage Full pipeline), upstream vendor isolation, and strict baseline craft arbitration. | `/paseo-ui`, UI设计, 界面优化 |

---

## 🚀 Quick Setup

### 1. Clone the repository
```bash
git clone https://github.com/hobart9527/paseo-skills.git ~/Codex/paseo-skills
```

### 2. Symlink into Claude Code / Agent Skills
```bash
mkdir -p ~/.claude/skills

# Symlink Paseo Pipeline
ln -sf ~/Codex/paseo-skills/skills/paseo-pipeline ~/.claude/skills/paseo-pipeline

# Symlink Paseo UI
ln -sf ~/Codex/paseo-skills/skills/paseo-ui ~/.claude/skills/paseo-ui
```

### 3. Sync Vendored UI Skills (Paseo UI)
Paseo UI locks 20 upstream best-of-breed skill slices locally via `LOCK.json`:
```bash
cd ~/Codex/paseo-skills/skills/paseo-ui/vendor
chmod +x sync.sh
./sync.sh
```

### 4. Deterministic Toolchain Prerequisites
Global tools required for automated a11y source-mapping audits and deep probe capture:
```bash
npm install -g @accesslint/cli @accesslint/chrome playwright @playwright/cli
```

---

## 🛠️ Skill Highlights

### 1. `paseo-pipeline`
- **Contract Freeze (`freeze-check.mjs`)**: Parses task DAG and waves, enforces scenario mapping, scope isolation, and narrow per-task verification before dispatch.
- **Paseo-native orchestration**: Paseo owns agents, workspaces, labels, and finish notifications; git owns durable state. No lease ledger or polling loop.
- **Frontier concurrency**: Tasks dispatch as soon as dependencies are Done and scopes are disjoint; vertical slices keep behavior, wiring, fixtures, and tests together.
- **Deterministic Merge (`merge-task.mjs`)**: Enforces provenance trailers, independent review, dependency completion, Write scope, drift checks, and frozen Verify before `--no-ff` integration.

### 2. `paseo-ui` (Paseo UI 2.0)
- **Dual-Mode Execution**:
  - **Lite Mode (Targeted Fast-Paths)**: one fast-path, one executor, tiered by blast radius (L-0 main session in place / L-1 Builder in a worktree / L-2 Builder + Designer spot check when shared primitives or tokens change). Every run captures before/after screenshots and probes:
    1. *Visual Texture & Polish* (`polish`, `bolder`, `typography`)
    2. *Colors & Dark Mode* (`color`)
    3. *Layout & Responsive* (`layout`)
    4. *Temporal & Motion* (`motion`)
    5. *Distill & Noise Reduction* (`distill`, `quieter`)
    6. *Microcopy* (`clarify`)
    7. *A11y & Engineering Audit* (`audit`, strictly read-only)
  - **Full Mode (Heavy Pipeline)**: 6-stage industrial lifecycle for 0→1 features, multi-screen refactors, and shared component design. Includes direction selection (A/B only for greenfield), isolated worktrees, mock-driven Break-UI states, dual-agent concurrent audit, and convergence. Nests inside `paseo-pipeline` when backend work is involved.
- **Single design constitution**: `DESIGN.md` is the only design source of truth; vendor skills that keep their own memory (e.g. `interface-design`'s `system.md`) are remapped into its sections.
- **`capture.mjs`**: multi-viewport × multi-state screenshots with DOM probes (overflow, per-control press-feedback coverage, touch targets); `--mock` injects network fixtures per state and confirms a state only when every route was hit.
- **Strict Arbitration Chain**:
  `Business Needs > Project Code/DESIGN.md > baseline-ui Bans > Slot Skills > Impeccable General > ui-ux-pro-max > Model Preferences`
- **Craft Hardening**:
  - Motion gate: strictly no animation unless requested (exempts `:active:scale-[0.96~0.98]` and focus rings).
  - Compositor only: only animate `transform` and `opacity`.
  - Typography: `tabular-nums` right-aligned for all financial/metric numbers.

---

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.
