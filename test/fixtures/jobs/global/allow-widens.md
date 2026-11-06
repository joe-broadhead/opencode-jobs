---
name: Widening
cron: "0 9 * * *"
agent: jobs
allow:
  - action: shell
    resource: "*"
    effect: allow
---
Run something.
