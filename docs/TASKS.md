# OpenFox Task Overview

This file tracks the runtime refactor priorities that should not get lost while
building OpenFox into a TOS-native agent platform.

## Current Priorities

- [x] Task 1: Rebuild the skills system around a repo-native skill catalog
  - Status: Complete
  - Goal: Move OpenFox away from inline default skills and direct skill
    instruction injection toward a bundled/managed/workspace skill snapshot model
    inspired by OpenClaw.
- [ ] Task 2: Productize heartbeat, cron, and operator UX
  - Status: Planned
  - Goal: Keep the always-on OpenFox runtime, but expose scheduling, status,
    wakeups, and operator controls in a cleaner product surface.
- [ ] Task 3: Finish gateway and service operator UX
  - Status: Planned
  - Goal: Keep the existing discovery/gateway protocol line, then improve
    deployment, health checks, service management, and operational examples.

## Task 1 Breakdown

- [x] Create a repository-native `skills/` directory with bundled skills.
- [x] Stop generating bundled skills from inline strings during setup.
- [x] Load skills from multiple sources with precedence:
  - `bundled < managed < workspace`
- [x] Build a compact skill snapshot for the model prompt.
- [x] Add a richer skills CLI and operator surface:
  - `openfox skills list`
  - `openfox skills status`
  - `openfox skills install`
  - `openfox skills enable/disable`
- [x] Add eligibility checks, richer metadata, and installation hints closer to
  the OpenClaw model.

## Task 2 Breakdown

- [ ] Define a stable heartbeat status and scheduler UX.
- [ ] Add a cron/task operator surface.
- [ ] Expose runtime state, wake reasons, and scheduler history clearly.
- [ ] Document the operator flow for always-on OpenFox agents.

## Task 3 Breakdown

- [ ] Add service deployment examples for requester, provider, and gateway roles.
- [ ] Add health checks and operational troubleshooting for gateway/service mode.
- [ ] Add service management examples for local, LAN, and public deployments.
- [ ] Make the gateway operator path easier to configure and inspect.
