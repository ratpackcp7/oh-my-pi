# CP7 Dashboard — environment context (benchmark fixture)

This file is frozen benchmark context. It describes the environment the Home
screen lives in. It contains no design answers — that is the candidate's job.

## What CP7 is

- **acerserver**: Ubuntu 24.04 headless home server (WiFi-only, Tailscale,
  `*.cp7.dev` via Cloudflare tunnel). Runs Docker services, systemd units,
  ollama, nightly Restic backups.
- **Home Assistant**: HAOS on a separate GMKtec G3 Plus box, reachable at
  `ha.cp7.dev`.
- **CP7 Hub**: the self-hosted dashboard web app (Next.js, standalone service)
  the owner uses daily on his phone (390 px-class viewport) and occasionally
  on desktop.
- **LLM infrastructure**: multiple LLM providers are in use through an
  OpenRouter-style gateway; provider/model rate-limit capacity is something
  the owner checks like fuel gauges — it belongs prominently on Home.

## What Home must answer in one glance

1. Is anything wrong right now? (Needs Attention)
2. Do I have provider/model headroom for today's work?
3. What is the solar/battery picture?
4. What is the house environment (rooms, temps, lights, occupancy)?
5. Are my systems healthy? (HA core, tunnels, backups)

Everything else — historical charts, device detail, automations, logs — is
drill-down material inside the dashboard, not Home content.

## Data

`home-data.representative.json` in this directory holds synthetic
representative values for all of the above. Values are illustrative, not live
readings; treat them as the truth for this exercise and label them as
representative in the mockup.
