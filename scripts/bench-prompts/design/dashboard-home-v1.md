# CP7 Dashboard — Home screen design concepts

You are doing design conception, not production implementation. All work
happens inside the current directory; do not modify anything outside it.

## Context

CP7 is a self-hosted smart-home operations dashboard for one house
(acerserver + Home Assistant, HAOS on a separate box). The **Home** screen is
the first thing the owner sees on his phone each morning. The current Home
passes its functional tests but reads as rearranged legacy cards, not a
designed surface — the redesign task is to conceive a genuinely better Home.

Representative (synthetic) data for the home is in
`home-data.representative.json` in this directory. Its values are
illustrative, not live readings; treat them as the truth for this exercise.

## Product direction

- Mobile first (390 px viewport); the same information architecture must scale
  to desktop (1440 px) without becoming a different product.
- Dense, flatter, dark **instrument-panel** feel — restrained dark blue/green
  accents, not decorative gradients or colorful card tiles.
- Home priority order, top to bottom:
  1. **Needs Attention** — only when something actually needs attention;
     absent otherwise.
  2. **Provider/model capacity** — the owner runs LLM infrastructure and
     checks it like fuel.
  3. **Solar** — production/consumption/battery at a glance.
  4. **Rooms / home environment** — temperatures, occupancy, lights.
  5. **Systems** — infrastructure health (HA core, tunnels, backups).
- Normal Live activity (motion events, presence pings) must **not** appear on
  Home unless it is actionable. A motion ping is noise; an open garage door
  is signal.
- No Quick Access clutter — no button grids of shortcuts.
- Few generic cards. Favor rows, meters, typography, and tiny charts over
  stacked tile cards.
- Progressive disclosure: Home shows state and entry points; details live one
  drill-down away inside the dashboard, not crammed onto Home.
- Truthful data only: use the fixture's values. Never invent percentages,
  meters, or metrics that the fixture doesn't contain. Label the data as
  representative somewhere subtle in the mockup.

## Deliverables (inside the current directory)

1. `DESIGN.md` — 2–3 **distinct** design concepts, one short paragraph each,
   then the concept you recommend with a brief rationale tied to the product
   direction above.
2. `index.html` — a single self-contained HTML mockup of the recommended
   concept (inline CSS/JS only, no external network dependencies), dark
   theme, usable at both 390 px and 1440 px.
3. Genuine rendered screenshots of the mockup, saved as PNG files:
   - `proofs/mobile-390-dark.png` — mobile, 390 px wide, dark
   - `proofs/desktop-1440-dark.png` — desktop, 1440 px wide, dark

The screenshots must be real renders of your HTML (render it in a headless
browser at the required viewport sizes). A placeholder or unrelated image is
not a proof.

## Anti-goals

- Do not write backend integration, production components, or tests.
- Do not fabricate data beyond the fixture.
- Do not pad the design with filler content to look complete.
