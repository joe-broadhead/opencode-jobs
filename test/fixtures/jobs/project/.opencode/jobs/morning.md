---
name: Morning brief
cron: "0 7 * * 1-5"
tz: Europe/London
agent: jobs
policy:
  overlap: queue-one
  maxLate: 24h
  timeout: 10m
---
Summarise yesterday's work and today's calendar in five lines.
