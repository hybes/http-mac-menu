# Design — HTTP Widgets

Locked design system for the shared Tauri app. Every screen reads this file
before visual changes are made. Amend this system intentionally; do not fork a
separate desktop, iOS, or Android interface.

## System

- Genre · modern-minimal
- Macrostructure · Workbench for app screens
- Theme · Cobalt, adapted to native system typography and controls
- Axes · cool-light paper / native grotesk UI / electric-cobalt signal
- Audience · people who want a useful widget without having to understand APIs
- Primary job · add, check, and act on a live value quickly
- Tone · calm, tactile, technical

## Macrostructure family

- App home · adaptive Workbench: compact native toolbar, live request surfaces,
  preset quick-start shelf, and progressive detail.
- Request editor · task-first Workbench: Source, Display, Schedule, and Alerts;
  uncommon API mechanics live under Advanced.
- Content/diagnostics · typography-only disclosure inside the app shell.

## Typography

- Display · platform rounded/system display face, weight 700, normal style.
- Body · platform UI face, weight 400 (350 in dark mode where supported).
- Mono · platform monospace for values, paths, and diagnostics only.
- Headings use tight tracking; live numbers use tabular figures.
- The platform stacks are deliberate: native feel takes precedence over loading
  a remote marketing font inside an installed utility app.

## Colour

- Cool tinted paper and graphite rather than pure white or black.
- Electric cobalt is a signal only: primary actions, selection, active state,
  charts, and focus. It must remain below roughly 5% of a viewport.
- Success, warning, and error states always pair colour with text or an icon.
- `tokens.css` is canonical for light and dark values.

## Spacing and shape

- 4-point named scale; production CSS uses `var(--space-*)`, not raw spacing.
- Controls share a 44px minimum height; coarse-pointer Android controls may use
  48px. Safe-area insets are part of the app shell.
- Cards 12px, panels 10px, inputs 8px. Buttons are compact rounded rectangles,
  not marketing pills.
- Hairlines provide structure; one quiet shadow is reserved for floating UI.

## Native shell

- Mobile · sticky app bar, independently scrolling content, safe-area-aware
  bottom actions. Back, title, and Save remain reachable in the editor.
- macOS · real traffic lights and a transparent drag region; never a visible
  fake title-bar strip. Closing or Escape hides settings and keeps the tray app
  alive.
- Windows/Android/iOS · one DOM and behaviour layer; platform classes may vary
  semantic tokens, safe areas, and control metrics only.

## Component and copy voice

- Primary action · cobalt fill, 8px radius, explicit verb (`Add request`,
  `Save`, `Refresh`).
- Secondary action · quiet bordered or text button using the same geometry.
- Icon-only actions always have an accessible label and at least a 44px target.
- Presets are visible choices, not a hidden select. Selecting one pre-fills the
  editor; saving remains explicit.
- Errors say what failed and what the user can do. Healthy notification state
  is quiet; permission problems become compact actionable banners.

## Motion and states

- Two primitives: press feedback and state crossfade/expansion.
- Silent success; copy buttons temporarily change their own label to `Copied`.
- Focus rings are instant. Every interactive component covers default, hover,
  focus, active, disabled, loading, error, and success states.
- Reduced motion removes spatial movement and caps opacity changes at 150ms.

## Per-page allowances

- App screens do not use decorative enrichment. Data and controls are the UI.
- Home may expand a request into one larger graph and metadata surface.
- Editor may reveal task-specific chips and disclosures, but never nests cards
  inside cards.

## What every screen must share

- Tokens, platform classes, toolbar rhythm, field geometry, focus treatment,
  notification renderer, status announcements, and action feedback.
- `html` and `body` use `overflow-x: clip`; mobile is verified at 320, 375, 414,
  and 768 CSS pixels.

## Exports

### `tokens.css`

`tokens.css` in the project root is the source of truth and includes the full
light/dark palette, typography, spacing, motion, rule, radius, shadow, and
z-index tokens.

### Tailwind v4 `@theme`

```css
@theme {
  --color-paper: oklch(97.8% 0.006 250);
  --color-paper-2: oklch(95.2% 0.009 250);
  --color-paper-3: oklch(91.8% 0.013 250);
  --color-ink: oklch(19% 0.027 258);
  --color-ink-2: oklch(30% 0.025 258);
  --color-rule: oklch(87% 0.012 250);
  --color-accent: oklch(55% 0.2 256);
  --color-focus: oklch(43% 0.19 256);
  --font-display: ui-rounded, -apple-system, system-ui, sans-serif;
  --font-body: -apple-system, system-ui, sans-serif;
  --font-mono: ui-monospace, 'SF Mono', 'Cascadia Mono', monospace;
  --spacing-3xs: 0.25rem;
  --spacing-2xs: 0.5rem;
  --spacing-xs: 0.75rem;
  --spacing-sm: 1rem;
  --spacing-md: 1.5rem;
  --spacing-lg: 2rem;
  --text-sm: 0.875rem;
  --text-base: 1rem;
  --text-md: 1.125rem;
  --radius-card: 12px;
  --radius-input: 8px;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
```

### DTCG `tokens.json`

```json
{
  "$schema": "https://design-tokens.github.io/community-group/format/",
  "color": {
    "paper": { "$value": "oklch(97.8% 0.006 250)", "$type": "color" },
    "ink": { "$value": "oklch(19% 0.027 258)", "$type": "color" },
    "accent": { "$value": "oklch(55% 0.2 256)", "$type": "color" },
    "focus": { "$value": "oklch(43% 0.19 256)", "$type": "color" }
  },
  "font": {
    "display": {
      "$value": "ui-rounded, -apple-system, system-ui, sans-serif",
      "$type": "fontFamily"
    },
    "body": {
      "$value": "-apple-system, system-ui, sans-serif",
      "$type": "fontFamily"
    },
    "mono": {
      "$value": "ui-monospace, SF Mono, Cascadia Mono, monospace",
      "$type": "fontFamily"
    }
  },
  "space": {
    "xs": { "$value": "0.75rem", "$type": "dimension" },
    "sm": { "$value": "1rem", "$type": "dimension" },
    "md": { "$value": "1.5rem", "$type": "dimension" }
  },
  "duration": {
    "micro": { "$value": "120ms", "$type": "duration" },
    "short": { "$value": "220ms", "$type": "duration" }
  }
}
```

### shadcn/ui CSS variables

```css
:root {
  --background: 97.8% 0.006 250;
  --foreground: 19% 0.027 258;
  --card: 99.1% 0.003 250;
  --card-foreground: 19% 0.027 258;
  --primary: 55% 0.2 256;
  --primary-foreground: 98.5% 0.006 250;
  --secondary: 91.8% 0.013 250;
  --secondary-foreground: 30% 0.025 258;
  --muted: 87% 0.012 250;
  --muted-foreground: 47% 0.02 255;
  --border: 87% 0.012 250;
  --input: 87% 0.012 250;
  --ring: 43% 0.19 256;
  --radius: 12px;
}
```
