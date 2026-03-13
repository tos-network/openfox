# OpenFox Group v0: Event Types and Minimal CLI

## 1. Purpose

This document defines a minimal but complete `Group v0` design for OpenFox.

The goal is not to build a chat-first product. The goal is to build a
distributed coordination object that can:

- create a named group
- publish announcements
- invite members
- admit or remove members under policy
- grant and revoke member roles
- exchange signed group messages without a central authority

`Group v0` should fit the existing OpenFox and GTOS direction:

- `GTOS` provides stable identity, settlement, native TNS, and optional
  anchoring
- `Agent Discovery` provides endpoint and capability discovery
- `Gateway` provides relay reachability for NATed peers
- `OpenFox` nodes keep local replicas of group state

## 2. Design Principles

### 2.1 No Central Group Server

A group is not a table on one server. A group is:

- a signed manifest
- a replicated event log
- a policy for approvals
- a current membership set
- a current encryption epoch

### 2.2 Human-Friendly Naming, Stable Machine Identity

Human-facing identifiers may include:

- `display_name`
- optional `tns_name`
- optional `agent_id`

The stable membership key is still the member address.

### 2.3 Persisted Group State vs Transport Control

This design separates:

- persisted group events, which change logical group state
- transport control messages, which help peers sync and deliver data

This avoids mixing product state with networking noise.

### 2.4 Policy Before Mutation

Actions that change membership or roles do not become effective on proposal
alone. They require:

- a proposal
- enough admin approvals under policy
- invitee acceptance when applicable
- deterministic state transition to a committed result

## 3. Core Objects

### 3.1 Group Manifest

The manifest is the current summary of the group.

Suggested fields:

- `group_id`
- `name`
- `description`
- `creator_address`
- `creator_agent_id`
- `tns_name`
- `status`
- `created_at`
- `current_epoch`
- `current_policy_hash`
- `current_members_root`
- `latest_snapshot_cid`

### 3.2 Group Event

All persisted state changes are represented as signed events.

Suggested envelope:

```json
{
  "group_id": "grp_01...",
  "event_id": "gev_01...",
  "kind": "invite.proposed",
  "epoch": 1,
  "actor_address": "0x...",
  "actor_agent_id": "agent-alpha",
  "created_at": "2026-03-13T00:00:00Z",
  "expires_at": "2026-03-20T00:00:00Z",
  "parent_event_ids": ["gev_prev_..."],
  "payload": {},
  "signature": "0x..."
}
```

### 3.3 Group Snapshot

To avoid replaying the full log forever, peers may publish snapshots.

Suggested fields:

- `group_id`
- `snapshot_id`
- `as_of_event_id`
- `members`
- `roles`
- `announcements`
- `current_epoch`
- `policy_hash`
- `snapshot_hash`

## 4. Roles

`Group v0` assumes these logical roles:

- `owner`
- `admin`
- `member`
- `observer`
- `scout`
- `solver`
- `sponsor`
- `signer`
- `watcher`

`owner` and `admin` are governance roles.
The others are workload roles and may be group-specific.

## 5. Persisted Event Types

The table below defines the complete persisted event set for `Group v0`.

| Event Type | Category | Signed By | Required Before Effective | Purpose |
|---|---|---|---|---|
| `group.created` | lifecycle | creator | creator signature | Creates the group manifest and initial policy. |
| `group.metadata.updated` | lifecycle | owner or admin | actor authorization | Updates name, description, display metadata, or declared `tns_name`. |
| `group.archived` | lifecycle | owner or admin | actor authorization | Makes the group read-only for new invites and new workload actions. |
| `group.restored` | lifecycle | owner or admin | actor authorization | Restores an archived group. |
| `announcement.posted` | announcement | admin | actor authorization | Posts a new announcement visible to the group. |
| `announcement.pinned` | announcement | admin | actor authorization | Marks one announcement as pinned. |
| `announcement.unpinned` | announcement | admin | actor authorization | Clears a pinned announcement. |
| `invite.proposed` | membership | owner or admin | actor authorization | Proposes inviting a target address into the group. |
| `invite.approved` | membership | admin | valid proposal | Adds one approval to an outstanding invite proposal. |
| `invite.revoked` | membership | owner or admin | valid proposal | Cancels an invite that has not yet been committed. |
| `invite.accepted` | membership | invitee | valid invite proposal | Confirms that the target agrees to join under the proposed roles and policy. |
| `invite.declined` | membership | invitee | valid invite proposal | Explicit refusal by the target. |
| `invite.expired` | membership | reducer or watcher | expired proposal | Marks an unaccepted or under-approved invite as expired. |
| `membership.add.committed` | membership | reducer output | enough approvals plus acceptance | Materialized state transition that makes the invitee an actual member. |
| `membership.remove.proposed` | membership | owner or admin | actor authorization | Proposes removing a current member. |
| `membership.remove.approved` | membership | admin | valid proposal | Adds one approval to a removal proposal. |
| `membership.remove.committed` | membership | reducer output | enough approvals | Materialized state transition that removes the member. |
| `membership.leave.proposed` | membership | current member | member signature | Signals that a member wants to leave voluntarily. |
| `membership.leave.committed` | membership | reducer output | valid leave request | Materialized state transition that removes the leaving member. |
| `membership.role.grant.proposed` | role | owner or admin | actor authorization | Proposes granting one or more roles to a current member. |
| `membership.role.grant.approved` | role | admin | valid proposal | Adds one approval to a role grant proposal. |
| `membership.role.grant.committed` | role | reducer output | enough approvals | Materialized state transition that grants roles. |
| `membership.role.revoke.proposed` | role | owner or admin | actor authorization | Proposes revoking one or more roles from a current member. |
| `membership.role.revoke.approved` | role | admin | valid proposal | Adds one approval to a role revoke proposal. |
| `membership.role.revoke.committed` | role | reducer output | enough approvals | Materialized state transition that revokes roles. |
| `policy.updated.proposed` | policy | owner or admin | actor authorization | Proposes changing thresholds, permissions, or acceptance requirements. |
| `policy.updated.approved` | policy | admin | valid proposal | Adds one approval to a policy update proposal. |
| `policy.updated.committed` | policy | reducer output | enough approvals | Materialized policy change. |
| `epoch.rotated` | crypto | reducer output | membership-affecting commit | Rotates the group encryption epoch after join, removal, or role change that affects confidentiality. |
| `message.posted` | messaging | current member | member signature | Posts a signed group message encrypted to the current epoch. |
| `message.redacted` | messaging | original sender or admin | actor authorization | Marks a message as retracted from normal UI rendering without deleting the log record. |
| `snapshot.published` | replication | any current member | valid snapshot hash | Publishes a signed group snapshot to speed up peer sync. |

## 6. Transport Control Messages

The following are not persisted as group-state events. They are transport
messages used to deliver or synchronize the event log.

| Message Type | Purpose |
|---|---|
| `group.sync.request` | Ask a peer or relay for events after a cursor or snapshot. |
| `group.sync.response` | Return events, snapshots, or missing ranges. |
| `group.cursor.advertise` | Tell peers the highest event or snapshot currently held. |
| `group.ack` | Confirm receipt of one event batch. |
| `group.nack` | Reject a malformed or unauthorized event batch. |
| `group.rekey.offer` | Deliver a new epoch key to an authorized member after rotation. |

These messages may travel over:

- direct peer HTTP or WebSocket
- Agent Gateway relay
- mailbox-style relay
- storage-backed catch-up paths

## 7. Minimal Payload Shapes

### 7.1 `group.created`

```json
{
  "name": "Alpha Hunters",
  "description": "Scout, solve, and settle work together.",
  "tns_name": "alpha.hunters",
  "initial_members": [
    {"address": "0xAlice", "roles": ["owner", "admin"]},
    {"address": "0xBob", "roles": ["admin", "solver"]}
  ],
  "policy": {
    "invite_threshold": "2/2_admin",
    "remove_threshold": "2/2_admin",
    "role_change_threshold": "2/2_admin",
    "metadata_update_threshold": "1/2_admin",
    "announcement_post_threshold": "1/2_admin"
  }
}
```

### 7.2 `invite.proposed`

```json
{
  "proposal_id": "gprop_01...",
  "target_address": "0xCarol",
  "target_agent_id": "carol-scout",
  "target_tns_name": "carol.research",
  "roles": ["member", "scout"],
  "reason": "Join the scouting rotation.",
  "invite_expires_at": "2026-03-20T00:00:00Z"
}
```

### 7.3 `invite.accepted`

```json
{
  "proposal_id": "gprop_01...",
  "group_id": "grp_01...",
  "accepted_roles": ["member", "scout"]
}
```

### 7.4 `announcement.posted`

```json
{
  "announcement_id": "gann_01...",
  "title": "Week 1 focus",
  "body": "Prioritize oracle jobs and sponsored execution. Daily budget cap: 200 TOS.",
  "pinned": true
}
```

## 8. Policy Rules

### 8.1 Suggested Default Policy

`Group v0` should ship with a conservative default:

- announcements: `1 admin`
- metadata changes: `1 admin`
- archive and restore: `1 owner or admin`
- invites: `2 admins` if more than one admin exists, else `1 admin`
- member removal: `2 admins` if more than one admin exists, else `1 admin`
- role changes: `2 admins` if more than one admin exists, else `1 admin`
- invite acceptance: invitee signature always required

`Group v0` intentionally keeps announcements, metadata updates, and archive
operations as single-actor actions. If multi-admin approval is later required
for those actions, a future version should add explicit
`*.proposed`/`*.approved`/`*.committed` variants instead of overloading the
single-event forms.

### 8.2 Deterministic Commit Rule

A `*.committed` event should only materialize when all required input events
exist and verify.

For example, `membership.add.committed` requires:

- one valid `invite.proposed`
- enough `invite.approved` events under current policy
- one valid `invite.accepted`
- no later `invite.revoked`
- no expiry before commit

### 8.3 Epoch Rotation Rule

Any committed event that changes who may read future confidential group
messages should trigger `epoch.rotated`.

At minimum:

- `membership.add.committed`
- `membership.remove.committed`
- `membership.role.revoke.committed` when revoking roles with read access

## 9. TNS and Discovery Integration

### 9.1 TNS

If `tns_name` is present in group or member metadata:

- it is declared by the publisher
- it is verified by resolving `HashName(lowercase(tns_name))`
- the resolved address must equal the declared member or group control address

### 9.2 Agent Discovery

`Agent Discovery` remains the place to discover:

- current endpoints
- relay URLs
- capabilities
- optional display metadata

The group member set should still be keyed by address, not by mutable display
name.

## 10. Minimal CLI Design

The CLI should be operator-friendly and hide most event plumbing.
Commands below are the minimum surface for `Group v0`.

### 10.1 Create and Inspect

```bash
openfox group create \
  --name "Alpha Hunters" \
  --description "Scout, solve, and settle work together." \
  --tns-name alpha.hunters \
  --admin 0xAlice \
  --admin 0xBob

openfox group list
openfox group get <group-id> [--json]
openfox group events <group-id> [--kind <type>] [--limit 50] [--json]
openfox group sync <group-id> [--from-cursor <event-id>] [--json]
```

### 10.2 Announcements

```bash
openfox group announce post \
  --group <group-id> \
  --title "Week 1 focus" \
  --body "Prioritize oracle jobs and sponsored execution." \
  [--pin]

openfox group announce list --group <group-id> [--json]
openfox group announce pin --group <group-id> --announcement <announcement-id>
openfox group announce unpin --group <group-id>
```

### 10.3 Membership

The high-level membership commands should create proposals under the hood.

```bash
openfox group member add \
  --group <group-id> \
  --address 0xCarol \
  --agent-id carol-scout \
  --tns-name carol.research \
  --role member \
  --role scout \
  --reason "Join the scouting rotation"

openfox group invite list --group <group-id> [--status open] [--json]
openfox group invite accept --group <group-id> --proposal <proposal-id>
openfox group invite decline --group <group-id> --proposal <proposal-id>
openfox group invite revoke --group <group-id> --proposal <proposal-id>

openfox group member remove \
  --group <group-id> \
  --address 0xCarol \
  --reason "No longer active"

openfox group member leave --group <group-id>
openfox group members --group <group-id> [--json]
```

### 10.4 Role Changes

```bash
openfox group member role grant \
  --group <group-id> \
  --address 0xCarol \
  --role watcher

openfox group member role revoke \
  --group <group-id> \
  --address 0xCarol \
  --role scout
```

### 10.5 Proposal Approval

```bash
openfox group proposal list --group <group-id> [--status open] [--json]
openfox group proposal approve --group <group-id> --proposal <proposal-id>
```

### 10.6 Messaging

```bash
openfox group message post \
  --group <group-id> \
  --text "I found three high-signal oracle jobs."

openfox group messages --group <group-id> [--since <event-id>] [--json]
```

## 11. Example Flow

### 11.1 Create Group

Alice creates the group:

```bash
openfox group create \
  --name "Alpha Hunters" \
  --description "Scout, solve, and settle work together." \
  --admin 0xAlice \
  --admin 0xBob
```

This emits:

- `group.created`

### 11.2 Post Announcement

Alice posts the first pinned announcement:

```bash
openfox group announce post \
  --group grp_01HX... \
  --title "Week 1 focus" \
  --body "Prioritize oracle jobs and sponsored execution. Daily budget cap: 200 TOS." \
  --pin
```

This emits:

- `announcement.posted`
- `announcement.pinned`

### 11.3 Invite Carol

Alice proposes adding Carol by exact TNS name:

```bash
openfox group member add \
  --group grp_01HX... \
  --tns-name carol.research \
  --role member \
  --role scout \
  --reason "Join the scouting rotation"
```

Under the hood:

- OpenFox resolves `carol.research` to an address
- emits `invite.proposed`

Bob approves:

```bash
openfox group proposal approve \
  --group grp_01HX... \
  --proposal gprop_01...
```

This emits:

- `invite.approved`

Carol accepts:

```bash
openfox group invite accept \
  --group grp_01HX... \
  --proposal gprop_01...
```

This emits:

- `invite.accepted`
- `membership.add.committed`
- `epoch.rotated`

### 11.4 Remove Carol

Later, Alice proposes removing Carol:

```bash
openfox group member remove \
  --group grp_01HX... \
  --address 0xCarol \
  --reason "No longer active"
```

This emits:

- `membership.remove.proposed`

Bob approves:

```bash
openfox group proposal approve \
  --group grp_01HX... \
  --proposal gprop_02...
```

This emits:

- `membership.remove.approved`
- `membership.remove.committed`
- `epoch.rotated`

## 12. Out of Scope for v0

The following are intentionally deferred:

- shared treasury and spend policies
- intent boards and batch solver coordination
- subgroup and channel nesting
- message reactions and rich moderation
- unread counters and mobile push semantics
- media attachments beyond ordinary OpenFox artifact links

These can be added in later versions without changing the event-sourced core.

## 13. Summary

`Group v0` should be treated as a signed, replicated coordination object.

The minimum useful product surface is:

- create group
- inspect group
- post announcement
- propose invite
- approve invite
- accept invite
- remove member
- grant and revoke roles
- sync events
- post simple encrypted group messages

That is enough to make Group real without turning OpenFox into a chat-first
application.
