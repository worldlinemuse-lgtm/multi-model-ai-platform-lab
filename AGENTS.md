# Lab repo instructions

## This is the sandbox

This repository is `worldlinemuse-lgtm/multi-model-ai-platform-lab` — the experimental duplicate of `multi-model-ai-platform`. **Break things here.** Half-finished UI, wild reorganization attempts, telemetry experiments, mockups that will never ship — it all belongs here.

## How it differs from production

| | Production (`multi-model-ai-platform`) | Lab (this repo) |
|---|---|---|
| Stability | Robbie's phone. Stable. | Anything goes. |
| Flow | Branch → PR → CI → merge → verify live | Push to main freely. Branch if you want, not required. |
| CI | Must be green before merge | Nice to have. Don't let red CI block an experiment. |
| Service-worker cache | MUST bump on every asset change | Bump when you want to test cache behavior; otherwise don't bother. |

## Promotion

When a lab experiment works and Robbie approves it, promote it to production through the **production** flow (branch → PR → CI → merge → verify live). The lab is a staging ground, not a fork — rebase on production main regularly so promotions stay clean:

```bash
git fetch prod   # prod = production remote
git merge prod/main
```

## Standing rules (inherited)

- Pure static GitHub Pages. No backend, no extensions, no network telemetry export.
- No live provider calls, keys, secrets, or charges without Robbie's explicit word.
- Robbie's phone is the acceptance environment for production — not for lab.

## Workflow doc

See `WORKFLOW.md` for the full lab/production setup.
