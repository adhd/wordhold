# Issue tracker: Local Markdown

Issues and PRDs for this repository live as Markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- PRD: `.scratch/<feature-slug>/PRD.md`
- Issues: `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state: a `Status:` line near the top of each issue using the roles in
  `triage-labels.md`
- Discussion: append under `## Comments`

When a skill publishes work to the issue tracker, it creates the corresponding
file under `.scratch/<feature-slug>/`. When it fetches a ticket, it reads the
path or issue number supplied by the user.
