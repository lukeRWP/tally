# Where the backlog lives

The backlog is the GitHub issue list, nothing else:

    gh issue list --repo lukeRWP/tally --state open

There is deliberately no roadmap document in this repository. One existed
(`docs/IMPROVEMENT-ROADMAP.md`, a June 2026 review synthesis) and it failed the
way static roadmaps do: nearly everything in it shipped within weeks and
nothing was ever ticked off, so readers had to cross-reference commits to learn
what was still true. It was removed in #358.

Review findings become issues (one per finding, with a `Found by` line naming
the review) and issues close from the PR that ships them (`Closes #n`), so the
open list is the plan and the closed list is the history. Anything that needs
Luke's decision rather than code carries that in the issue body.
