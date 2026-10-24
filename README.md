# Paseo Skills

Production-grade agent skills for autonomous engineering delivery, multi-agent pipeline orchestration, and frontend UI/UX engineering.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 📦 What's Included

| Skill | Directory | Description | Trigger |
| :--- | :--- | :--- | :--- |
| **Paseo Pipeline** | [`skills/paseo-pipeline`](skills/paseo-pipeline) | Industrial multi-agent engineering delivery pipeline. Integrates OpenSpec lifecycle, declarative contract gates, and automated merge verification. | `/paseo-pipeline`, 流水线交付 |
| **Paseo UI (2.0)** | [`skills/paseo-ui`](skills/paseo-ui) | AI-Native frontend and UI/UX industrial delivery pipeline. Features dual-mode execution (5 Lite fast-paths + 6-stage Full pipeline), upstream vendor isolation, and strict baseline craft arbitration. | `/paseo-ui`, UI设计, 界面优化 |

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
Paseo UI locks 10 upstream best-of-breed skill slices locally via `LOCK.json`:
```bash
cd ~/Codex/paseo-skills/skills/paseo-ui/vendor
chmod +x sync.sh
./sync.sh
```

---

## 🛠️ Skill Highlights

### 1. `paseo-pipeline`
- **OpenSpec Lifecycle**: Bound to OpenSpec (`proposal` -> `specs` -> `design` -> `tasks` -> `validate` -> `apply` -> `archive`).
- **Separation of Concerns**: OpenSpec manages task lifecycles; `list_profiles` notes dictate model capabilities; Pipeline exclusively handles autonomous dispatch.
- **Contract Verification (`contract-check.mjs`)**: Enforces explicit dependency trees, verifies file boundary isolations, and prevents race conditions.
- **Deterministic Merge (`merge-task.mjs`)**: Safe automated merge back to trunk with pre-commit gates.

### 2. `paseo-ui` (Paseo UI 2.0)
- **Dual-Mode Execution**:
  - **Lite Mode (Targeted Fast-Paths)**: Single-agent targeted dispatch (`shejishi_builder`, `jiangzuo`, or `anchasi`) for rapid, focused fixes:
    1. *Visual Texture & Polish*: `interface-design` + `better-typography` + `better-ui/icons`
    2. *Colors & Dark Mode*: `better-colors` (single responsibility scale, contrast)
    3. *Temporal & Motion*: `to-spring` + `micro-interaction` + `accessible-animation`
    4. *Distill & Noise Reduction*: `distill` + `quieter` (6-dimension declutter)
    5. *A11y & Engineering Audit*: `accessibility-scan` + `audit` (strictly read-only)
  - **Full Mode (Heavy Pipeline)**: 6-stage industrial lifecycle for 0→1 features, multi-screen refactors, and shared component design. Includes A/B direction selection, isolated worktrees, break-ui hardening, dual-agent concurrent audit, and convergence.
- **Strict Arbitration Chain**:
  `Business Needs > Project Code/DESIGN.md > baseline-ui Bans > Slot Skills > Impeccable General > ui-ux-pro-max > Model Preferences`
- **Craft Hardening**:
  - Motion gate: strictly no animation unless requested (exempts `:active:scale-[0.96~0.98]` and focus rings).
  - Compositor only: only animate `transform` and `opacity`.
  - Typography: `tabular-nums` right-aligned for all financial/metric numbers.

---

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.
