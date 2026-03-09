# OpenFox Task Overview

This file tracks the runtime refactor priorities that should not get lost while
building OpenFox into a TOS-native agent platform.

## Current Priorities

- [x] Task 1: Rebuild the skills system around a repo-native skill catalog
  - Status: Complete
  - Goal: Move OpenFox away from inline default skills and direct skill
    instruction injection toward a bundled/managed/workspace skill snapshot model
    inspired by OpenClaw.
- [x] Task 2: Productize heartbeat, cron, and operator UX
  - Status: Complete
  - Goal: Keep the always-on OpenFox runtime, but expose scheduling, status,
    wakeups, and operator controls in a cleaner product surface.
- [x] Task 3: Finish gateway and service operator UX
  - Status: Complete
  - Goal: Keep the existing discovery/gateway protocol line, then improve
    deployment, health checks, service management, and operational examples.
- [x] Task 4: Add managed service install and lifecycle UX
  - Status: Complete
  - Goal: Make OpenFox easier to run as an always-on user service with
    install/start/stop/restart/uninstall flows closer to OpenClaw.

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

- [x] Define a stable heartbeat status and scheduler UX.
- [x] Add a cron/task operator surface.
- [x] Expose runtime state, wake reasons, and scheduler history clearly.
- [x] Document the operator flow for always-on OpenFox agents.

## Task 3 Breakdown

- [x] Add service deployment examples for requester, provider, and gateway roles.
- [x] Add health checks and operational troubleshooting for gateway/service mode.
- [x] Add service management examples for local, LAN, and public deployments.
- [x] Make the gateway operator path easier to configure and inspect.

## Task 4 Breakdown

- [x] Add Linux user-systemd install and uninstall flows.
- [x] Add start/stop/restart lifecycle commands.
- [x] Surface managed service state in the operator CLI.
- [x] Document managed service installation and runtime expectations.
