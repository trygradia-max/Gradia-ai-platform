# Token diff — 2026-10-09

First visual slice on `codex/cursor-component-polish`. Semantic CSS variables
only. No theme switch. Light tokens stay defined and unshipped.

| Token | Before | After | Role |
| --- | --- | --- | --- |
| `--bg-canvas` | `oklch(0.06 0 0)` | `#101217` | Page canvas |
| `--bg-surface` | `oklch(0.1 0 0)` | `#181B22` | Cards, sidebar |
| `--bg-raised` | `oklch(0.12 0 0)` | `#222630` | Popovers, selected rows |
| `--bg-sunken` | `oklch(0.07 0 0)` | `#101217` | Same as canvas; sidebar no longer uses it |
| `--bg-hover` | `oklch(0.14 0 0)` | `#2A303C` | Row / nav hover |
| `--border-default` | `oklch(0.18 0 0)` | `#303642` | Card / pane hairlines |
| `--border-strong` | `oklch(0.26 0 0)` | `#303642` | Same quiet divider |
| `--border-control` | *(new)* | `#64748B` | Inputs, outline buttons |
| `--text-primary` | `oklch(0.985 0 0)` | `#F4F5F7` | Body / titles |
| `--text-secondary` | `oklch(0.7 0 0)` | `#A5ADBA` | Helpers, timestamps |
| `--primary` / `--accent` | `#7C3AED` | `#7C3AED` | Filled primary |
| `--primary-foreground` | `oklch(0.985 0 0)` | `#FFFFFF` | Text on filled primary |
| `--accent-hover` | `#6D28D9` | `#6D28D9` | Primary hover (`--color-primary-hover`) |
| `--accent-text` | `#A78BFA` | `#A78BFA` | Links |
| `--ring` | `--accent` (`#7C3AED`) | `--accent-text` (`#A78BFA`) | Focus / selected |
| `--input` | `--border-default` | `--border-control` | Control boundary |
| `--sidebar` | `--bg-sunken` | `--bg-surface` (`#181B22`) | Sidebar fill |
| `--sidebar-ring` | `--accent` | `--accent-text` | Sidebar focus |
| `--status-success-fg` | `#4ADE80` | `#4ADE80` | Success text |
| `--status-warning-fg` | `#FBBF24` | `#FBBF24` | Held / needs review |
| `--status-danger-fg` | `#FB7185` | `#FB7185` | Error / destructive |

Radii unchanged: 6px controls (`--radius-sm`), 10px cards (`--radius-md`),
16px dialogs (`--radius-lg`). Geist and the compact type scale stay.

Control edges use `--border-control`. Cards and panes use `--border-default`
so every card is not painted with the louder slate.
