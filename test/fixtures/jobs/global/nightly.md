---
name: Nightly review
schedule:
  every: 6 hours
agent: reviewer
target:
  model:
    providerID: anthropic
    id: claude-sonnet-4
---
Review the open pull requests and list the one that needs attention first.
