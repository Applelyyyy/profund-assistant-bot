---
name: TA Queue
description: A clear operational ledger for coursework queues and TA room ownership.
colors:
  bg: "#111318"
  sidebar: "#15171e"
  surface: "#1b1e27"
  elevated: "#242833"
  fg: "#f0f1f6"
  muted: "#a6adbd"
  border: "#343a48"
  primary: "#898aff"
  primary-text: "#111318"
  primary-soft: "#292b48"
  success: "#75d8ae"
  success-soft: "#1e3630"
  warning: "#f2c375"
  warning-soft: "#3b3021"
  danger: "#ff929c"
  danger-soft: "#3c252d"
  light-bg: "#f5f6fa"
  light-sidebar: "#fff"
  light-surface: "#fff"
  light-elevated: "#edf0f6"
  light-fg: "#202430"
  light-muted: "#626b7d"
  light-border: "#d7dce6"
  light-primary: "#5555c7"
  light-primary-text: "#fff"
  light-primary-soft: "#ededff"
  light-success: "#187554"
  light-success-soft: "#e6f5ee"
  light-warning: "#825408"
  light-warning-soft: "#fff1d9"
  light-danger: "#b63044"
  light-danger-soft: "#ffecef"
typography:
  headline:
    fontFamily: "IBM Plex Sans, sans-serif"
    fontSize: "29px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: "IBM Plex Sans, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  metric:
    fontFamily: "IBM Plex Sans, sans-serif"
    fontSize: "29px"
    fontWeight: 500
    lineHeight: 1.2
  body:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
  button:
    fontFamily: "DM Sans, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.5
rounded:
  preview: "4px"
  badge: "5px"
  field: "7px"
  control: "8px"
  panel: "12px"
  dialog: "14px"
spacing:
  "4": "4px"
  "8": "8px"
  "12": "12px"
  "16": "16px"
  "24": "24px"
  "32": "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-text}"
    rounded: "{rounded.control}"
    padding: "9px 14px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "9px 14px"
  button-secondary-hover:
    backgroundColor: "{colors.elevated}"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.button}"
    padding: "6px 0"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.field}"
    padding: "10px 12px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.panel}"
  badge-success:
    backgroundColor: "{colors.success-soft}"
    textColor: "{colors.success}"
    rounded: "{rounded.badge}"
    padding: "4px 8px"
  navigation-active:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary}"
    rounded: "{rounded.field}"
    padding: "10px 12px"
---

# Design System: TA Queue

## Overview

**Creative North Star: "Academic Session Ledger"**

The academic session ledger makes queue identity, TA ownership, capacity, and recovery easy to scan. Its premium SaaS character comes from aligned work surfaces, restrained indigo, clear status words, and self-hosted typography. Dark is the default; light preserves the same hierarchy and operational meaning.

This is an administration workspace. Borders and tonal layers organize dense information, while imagery and decorative entrance motion yield to the work. Counts, timestamps, service states, and empty states remain grounded in platform records; Discord previews explicitly identify example values.

**Key Characteristics:**

- Queue and room ownership stay legible.
- Dark and light share one hierarchy.
- Indigo identifies actions and selection; semantic colors identify state.
- Bordered surfaces, compact tables, visible field labels, and explicit recovery.

## Colors

Cool charcoal layers and a restrained indigo action color keep operational state distinct from navigation. The frontmatter records the default palette and each light-theme counterpart; live components use the CSS variables in `apps/web/app/globals.css`.

### Primary

- **Ledger Indigo** (`primary`): primary actions, selected navigation, focus, and the brand mark. `primary-soft` supports selected rows and setup guidance; `primary-text` provides its paired foreground.

### Secondary

- **Verified Green** (`success`, `success-soft`): accepting, completed, registered, open, and online states.
- **Review Amber** (`warning`, `warning-soft`): draining, needs-review, and escalated states.
- **Recovery Rose** (`danger`, `danger-soft`): failed moves, failed sync, offline, and cancelled states. Moving, claimed, in-progress, sync-pending, and running use the primary tone.

### Neutral

- **Canvas Charcoal** (`bg`) and **Sidebar Charcoal** (`sidebar`): the workspace and navigation shell.
- **Ledger Surface** (`surface`) and **Raised Neutral** (`elevated`): panels, neutral badges, hover, and nested details.
- **Reading White** (`fg`), **Secondary Slate** (`muted`), and **Divider Slate** (`border`): primary content, supporting text, and structural separation. Light counterparts keep these roles on a cool pale canvas and white surfaces.

**The State Has Words Rule.** Color supports an explicit status label; it never carries operational meaning alone.

## Typography

**Heading Font:** IBM Plex Sans, sans-serif. **Body Font:** DM Sans, sans-serif. Both are self-hosted through `@fontsource` imports. IBM Plex Sans (500/600) carries headings and metric values; DM Sans (400/500/600) carries work and controls. There is no separate ornamental display face. Noto Sans Thai is self-hosted as the fallback for Thai student content and Discord previews. Its font and OFL license are bundled in `apps/web/public/fonts`; English interface copy retains the existing fonts.

### Hierarchy

- **Headline:** page heading; the headline token reduces to (25px) below the tablet breakpoint and becomes (26px) on phones.
- **Title:** panel headings; subsection headings use (16px, 600).
- **Metric:** large counts with tabular numerals; phone counts use (27px).
- **Body:** default application reading text. Supporting page copy and buttons use (13px); operational tables and field labels use (12px).
- **Label:** compact field and metric labels. Labels retain ordinary sentence case.

**The Ledger Numerals Rule.** Use tabular numerals for metric counts and aligned numeric queue data.

## Layout

The desktop shell uses a fixed sidebar (244px) and a main column capped at (1660px), with a topbar (77px) and main padding (34px 32px 0). Repeated gaps use the frontmatter spacing scale; panels commonly separate by (24px). Panel headings and table cells align to an inset (22px). Metric cards form five columns; supporting panels use a (1.7:1) split. Form fields normally form two columns.

At (1200px), the sidebar narrows to (220px), main horizontal padding becomes (24px), the supporting split becomes (1.4:1), and the embed editor stacks. At (900px), the sidebar is (204px), metrics form three columns, supporting panels stack, and main horizontal padding is (18px). At (680px), a labeled page selector replaces the sidebar, the topbar becomes (66px), main horizontal padding becomes (16px), forms stack, and metrics use two columns with the final card spanning both. Heading actions wrap; the refresh action becomes an icon with its label retained in the control's content.

Tables fill their panel and scroll horizontally within it. Dialogs fit the viewport width and height and scroll internally. Reduced motion disables transitions and animations.

## Elevation & Depth

Borders and tonal surfaces create everyday depth. Panels do not cast shadows. Floating UI uses a dark translucent overlay and diffuse shadows, without hard offset edges.

### Shadow Vocabulary

- **Dialog:** `0 18px 70px #0004`, above the overlay (`#06080cbf`).
- **Notification:** `0 8px 30px #0003`, for the fixed bottom-right toast; on phones the toast spans the available width with (16px) margins.

**The Flat Work Surface Rule.** Ordinary panels stay flat. Reserve shadows for floating dialogs and notifications.

## Shapes

Thin borders (1px) and gently rounded rectangles form the workspace. Panels use the panel radius; controls use the control radius, fields and navigation the field radius, and badges the badge radius. Dialogs have slightly softer corners. Circular initials identify people, while the brand uses a compact rounded square. These shapes stay consistent across themes.

## Components

### Buttons

Compact, clearly bounded actions. Secondary buttons use the surface, border, and foreground; hover shifts to elevated neutral with a muted border. Primary buttons use paired primary colors and weight (600); hover brightens them (`brightness(1.08)`). Text actions use muted text and brighten on hover. Base controls have minimum height (44px), the button padding token, and inline SVG icons separated by (8px). Disabled buttons reduce opacity to (0.5) and use a blocked cursor. Keyboard focus uses a primary outline (2px) with offset (3px). State feedback transitions background, color, and border color over (0.15s).

### Chips

Status badges pair semantic text with its soft background, at (11px, 500), line-height (1.4), and the badge padding/radius tokens. They report state rather than serving as filter controls. Neutral badges use elevated neutral and muted text.

### Cards / Containers

Panels use surface, a thin border, panel radius, and clipped corners. Headers have desktop padding (21px 22px 18px); content aligns to the same inset. Metric cards use padding (18px 18px 16px). Empty states pair a clear title with a concise next step instead of filling space with fabricated records.

### Inputs / Fields

Fields have visible, programmatically associated labels and optional associated hints. Inputs use the canvas background, border, field radius, minimum height (44px), and field padding token. Textareas resize vertically and start at (90px). Checkboxes are (18px) inside a labeled row with minimum height (44px). Disabled fields use opacity (0.65). Search wraps an icon and input in one border and applies the focus outline to the wrapper. Errors appear in explicit alert notices; no universal red field-border variant is established.

### Navigation

Sidebar links pair inline SVG icons with text, muted at rest and elevated on hover. Active links use primary-soft and primary and expose `aria-current="page"`. The queue count appears only when there are waiting tickets. Phones use a native select with an associated page label. The topbar keeps theme switching, account identity, and sign-out available; the saved theme persists in local storage.

### Tables, dialogs, and feedback

Tables use (12px) body text, muted (11px) headings on the canvas, desktop cell padding (16px 22px), and a subtle elevated row hover. Radix dialogs trap focus, provide a title and description, and disable their form fieldset while a mutation is busy. Destructive or discard actions use explicit confirmations. Toasts expose success as a status and errors as alerts, with a named dismiss action. The skip link becomes visible on keyboard focus.

### Discord preview

The embed builder is a form beside a sticky preview on wide desktops; it stacks below (1200px). The preview preserves Discord's own charcoal, blue, green, and red materials independently of the administration theme. Traditional embeds and Components V2 have distinct preview shapes. Preview counts are explicitly examples; saved drafts, publication state, and version history remain separate operations. These external-platform styles are not administration tokens.

## Do's and Don'ts

### Do:

- **Do** use the existing semantic CSS variables so every new surface follows both themes.
- **Do** preserve visible field labels, keyboard focus, and explicit error or recovery text.
- **Do** use SVG icons with accessible names on icon-only actions.
- **Do** keep wide tables inside their own horizontal scroll container.
- **Do** use 44px minimum action targets for new controls.

### Don't:

- **Don't** invent queue entries, health, activity, rankings, or predictive wait times.
- **Don't** add decorative marketing imagery or ornamental entrance sequences to operational screens.
- **Don't** apply Discord preview colors to the surrounding administration interface.
- **Don't** shrink essential instructions or controls to match incidental metadata.
