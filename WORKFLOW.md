# Lab / Production Workflow

Two repos, one codebase, clear promotion path.

## The repos

| | Production | Lab |
|---|---|---|
| Repo | `multi-model-ai-platform` | `multi-model-ai-platform-lab` |
| Local | `~/workspace/mm-ap` | `~/workspace/mm-lab` |
| Site | https://worldlinemuse-lgtm.github.io/multi-model-ai-platform/ | https://worldlinemuse-lgtm.github.io/multi-model-ai-platform-lab/ |
| Purpose | Stable. Robbie's phone. | Break things here. |

## Rules

1. **Production** (`mm-ap`): feature branch → PR → CI green → merge → verify live. Same as always. Nothing experimental lands here directly.
2. **Lab** (`mm-lab`): push freely. Experiment branches, wild ideas, half-finished UI — it all lives here. Pages deploys from `main` so experiments are viewable live.
3. **Promotion**: when a lab experiment works, cherry-pick or PR it into production through the normal flow. The lab is the staging ground, not a fork — keep it rebased on production main so promotions stay clean.

## Keeping lab in sync

```bash
cd ~/workspace/mm-lab
git fetch origin
git pull origin main          # lab's own main
# To catch up with production:
cd ~/workspace/mm-ap
git checkout main && git pull
cd ~/workspace/mm-lab
git fetch ../mm-ap main:prod-main   # or add production as a remote
git merge prod-main
```

Simpler: in `mm-lab`, add production as a remote once:

```bash
git remote add prod https://github.com/worldlinemuse-lgtm/multi-model-ai-platform.git
git fetch prod
git merge prod/main   # fast-forward lab to production
```

## What belongs where

- **Lab**: IDE reorganization mockups, dockable panel v2, new tab designs, telemetry experiments, anything Robbie says "try it."
- **Production**: only what Robbie has approved and we've verified live.

## Created

2026-10-18. Lab seeded from production main at `a81133e` (PR #55 merge).
