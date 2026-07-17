# Telegram Guard Design

**Date:** 2026-07-17
**Status:** Ready for review

## Summary

Telegram Guard adds a local group-management daemon for Telegram CLI. It starts with `tg guard start`, opens the local web management UI, watches configured groups, evaluates rules against new messages and member events, executes moderation or trigger actions, and records every event and action in local SQLite.

The design follows Combot's broad product shape: moderation, anti-spam, trigger responses, welcome flows, and activity visibility. The first version intentionally keeps the system local-first. It does not add hosted deployment, remote access, AI moderation, CAS integration, or a system background-service installer.

## Goals

- Add `tg guard start` as the entry point for a foreground guard daemon.
- Let users configure managed groups and rules from the local web UI.
- Use one rule model for automatic moderation and community-operation triggers.
- Support link, invite-link, keyword, regex, flood, repeated-message, new-member, command, and warning-count conditions.
- Support delete, warn, mute, ban, reply, send-message, and record-only actions.
- Persist managed groups, rules, member warning state, event logs, action logs, and runtime status in local SQLite.
- Reuse existing account/session handling, Telegram client creation, group write operations, web server conventions, and local-only security posture.
- Keep runtime, storage, and Web API boundaries portable enough for a later server-oriented mode.

## Non-goals

- Building a full Combot clone in the first version.
- Hosted or LAN-accessible web administration.
- Login, OAuth, token authentication, or multi-user web access.
- macOS launchd, systemd, Windows service installation, process supervision, or high availability.
- Cross-device configuration sync.
- Cross-group rule inheritance or global rule templates.
- Reputation, XP, public leaderboards, or gamification.
- AI moderation, image moderation, scam classifiers, or CAS/external spam-list lookups.
- Complex graphical trigger-builder DSL.
- Real Telegram integration tests in CI.

## Product Scope

The first version is a local management workbench. A user runs:

```text
tg guard start
```

The command starts a foreground process that:

1. Serves the local web UI on `127.0.0.1`.
2. Loads guard configuration from local SQLite.
3. Starts listeners for enabled account/group pairs.
4. Applies enabled rules to incoming guard events.
5. Executes safe Telegram write actions through an action queue.
6. Records actions, skipped actions, dry-runs, and failures.

The web UI is the primary configuration surface. The first version does not add rule import/export commands; users create and edit rules in the browser.

## Command Contract

```text
tg guard start
  [--port <port>]
```

- The command binds to `127.0.0.1`.
- The default port follows the existing web UI default of `8734`, incrementing when omitted and unavailable.
- Startup output prints the local URL.
- The process runs until interrupted.
- The command starts both the web UI and the guard runtime.
- `tg web` remains a non-runtime web entry point in the first version. It must not start listeners or execute rules.
- Remote writes still obey the existing `write-access` policy. When write access is off, actions are recorded as dry-runs or skipped instead of mutating Telegram.

## Architecture

New guard code lives in focused modules:

- `src/commands/guard.ts`: registers `tg guard start`.
- `src/guard/runtime.ts`: owns account/group listener lifecycle and runtime status.
- `src/guard/rule-engine.ts`: evaluates conditions against normalized events.
- `src/guard/action-planner.ts`: deduplicates, orders, and validates candidate actions.
- `src/guard/action-queue.ts`: serializes Telegram writes, handles flood waits, and records execution results.
- `src/guard/types.ts`: defines public guard event, condition, action, and result shapes.
- `src/storage/guard-db.ts`: persists configuration, member state, events, actions, and runtime state.
- `src/web/guard-api.ts`: exposes guard configuration, status, test, and activity endpoints.
- `web/src/`: adds Guard pages to the existing React app.
- `src/telegram/`: reuses existing mtcute adapters and adds narrowly scoped listener/reply/delete methods only when required.

The runtime must not depend on Commander, CLI presenters, or the web server. It receives dependencies through constructors and talks to storage/services through typed interfaces.

## Event Flow

```text
Telegram update
  -> GuardRuntime
  -> GuardEvent normalization
  -> RuleEngine evaluates enabled rules
  -> ActionPlanner filters and orders actions
  -> ActionQueue executes writes or dry-runs
  -> GuardDB records events, actions, warnings, and errors
  -> Web UI reads status and logs through API
```

Initial normalized event types:

- `message_created`
- `member_joined`

The event type model keeps space for future `message_edited`, `message_deleted`, `join_request_created`, and scheduled events, but the first version implements only `message_created` and `member_joined`.

## Rule Model

Rules are scoped to a managed group. Each rule has:

- `id`
- `group_id`
- `name`
- `enabled`
- `priority`
- `conditions_json`
- `actions_json`
- `created_at`
- `updated_at`

Conditions are ANDed in the first version. A later UI can add condition groups for OR logic.

Example:

```json
{
  "name": "Block invite links from new members",
  "enabled": true,
  "priority": 100,
  "conditions": [
    { "type": "message_contains_invite_link" },
    { "type": "member_age_less_than", "seconds": 86400 }
  ],
  "actions": [
    { "type": "delete_message" },
    { "type": "warn", "reason": "Invite links are not allowed" },
    { "type": "mute", "seconds": 600 }
  ]
}
```

Initial condition types:

- `message_contains_text`
- `message_matches_regex`
- `message_contains_url`
- `message_contains_invite_link`
- `message_repeated`
- `message_rate_exceeded`
- `member_is_new`
- `member_age_less_than`
- `message_command`
- `member_warning_count_at_least`

Initial action types:

- `delete_message`
- `warn`
- `mute`
- `ban`
- `reply`
- `send_message`
- `record_only`

Condition and action JSON must be validated with TypeScript-level schemas before being persisted or executed. Invalid stored rules should be disabled or skipped with a structured log entry, not crash the daemon.

## Safety Boundary

Guard writes are potentially destructive, so the runtime must preserve explicit safety controls.

Required behavior:

- Respect the existing `write-access` setting.
- Support per-group switches for delete, mute, and ban actions.
- Ignore administrator messages by default.
- Ignore messages from bots and the current account by default.
- Avoid automatic reply loops by ignoring the guard account's own messages.
- Apply cooldowns for `reply` and `send_message` actions.
- Deduplicate same-kind actions for the same event.
- Treat Telegram flood waits as delayed queue work when practical.
- Record skipped actions with a reason.
- Pause a group after repeated fatal errors, permission errors, or unsupported group errors.

Every action attempt gets a local record, including:

- executed successfully
- skipped by safety policy
- dry-run because write access is off
- failed due to Telegram error
- delayed due to flood wait

## Web UI

The Guard UI is a work-focused management interface with four areas.

### Guard Overview

- Runtime status.
- Active accounts.
- Running, paused, and error groups.
- Queue length.
- Recent errors.
- Existing write-access state.

### Managed Groups

- Select groups to manage.
- Enable or pause a managed group.
- Configure safety switches: allow delete, allow mute, allow ban.
- Configure defaults: ignore admins, ignore bots, reply cooldown, action cooldown.

### Rules

- List rules for a group.
- Create, edit, enable, disable, and delete rules.
- Configure conditions through forms.
- Configure actions through forms.
- Set priority.
- Test a rule against sample text and member metadata without calling Telegram.

### Activity

- Show recent guard events and actions.
- Filter by account, group, user, rule, action type, and status.
- Show skipped and failed reasons.

The first version should use a straightforward form editor. It should not attempt a visual node graph or advanced DSL builder.

## Web API

Initial endpoints:

```text
GET    /api/guard/status
GET    /api/guard/groups
POST   /api/guard/groups
PATCH  /api/guard/groups/:id
GET    /api/guard/rules
POST   /api/guard/rules
PATCH  /api/guard/rules/:id
DELETE /api/guard/rules/:id
POST   /api/guard/rules/test
GET    /api/guard/activity
```

API responses use the existing web API envelope:

```json
{ "ok": true, "data": {} }
```

Failures use:

```json
{ "ok": false, "error": { "code": "invalid_request", "message": "..." } }
```

The API must continue the current local-only protections:

- Bind only to `127.0.0.1`.
- Do not enable CORS.
- Validate local Host and Origin.
- Accept JSON only for mutating routes.
- Enforce request body limits.
- Never expose Telegram sessions, API hash, proxy credentials, database paths, or credential files.

## Storage

Add a separate guard storage area rather than mixing rule state into the existing message tables.

Initial tables:

- `guard_managed_groups`
  - account, chat_id, title, enabled, runtime status, safety switches, default policy JSON.
- `guard_rules`
  - group_id, name, enabled, priority, conditions_json, actions_json, timestamps.
- `guard_member_state`
  - group_id, user_id, warning_count, first_seen_at, last_seen_at, last_message_at.
- `guard_events`
  - group_id, event_type, chat_id, message_id, user_id, matched_rule_ids JSON, created_at.
- `guard_actions`
  - event_id, rule_id, action_type, status, Telegram result/error JSON, created_at.
- `guard_runtime_state`
  - latest startup time, latest error summary, queue length, runtime metadata JSON.

Use JSON for conditions and actions in the first version. That keeps the form editor, import/export, and schema evolution simple. Add dedicated columns later only when filtering or indexing requires them.

## Error Handling

Guard errors should be visible without taking down the whole process.

- Rule validation failures mark the rule invalid and log `rule_invalid`.
- Missing Telegram permissions mark the action failed and can pause the group if repeated.
- Flood waits delay queued writes and log `flood_wait`.
- Deleted or inaccessible chats mark the group `error`.
- Database write failures should surface in runtime status and stderr.
- Unexpected runtime errors should not expose secrets in Web API responses.

Structured error codes should be stable enough for tests and future CLI automation.

## Testing

Unit tests:

- RuleEngine condition matching.
- AND condition composition.
- Rule priority ordering.
- Regex validation and failure handling.
- URL and invite-link detection.
- Message rate and repeated-message detection.
- Warning-count conditions.
- ActionPlanner deduplication.
- Admin, bot, current-account, cooldown, and group safety switches.
- Write-access off dry-run behavior.

Storage tests:

- Managed group CRUD.
- Rule CRUD and schema validation.
- Event/action insertion.
- Warning count updates.
- Runtime state updates.
- Migration from an empty database.

Runtime tests:

- Fake Telegram update produces a guard event.
- Matching rule produces actions.
- Queue executes actions in order.
- Flood wait delays or records delayed work.
- Permission failure records an error and pauses when policy requires it.
- Runtime ignores self messages.

Web API tests:

- Status response.
- Managed group create/update validation.
- Rule create/update/delete validation.
- Rule test endpoint.
- Activity pagination and filters.
- Invalid Host/Origin rejection.
- JSON content-type and body limit enforcement.

Frontend tests can stay focused on form behavior and API error rendering. Real Telegram calls are not part of automated tests; use fake adapters.

## Open Implementation Notes

- Prefer reusing existing group write service methods for destructive actions.
- If the current listen path already exposes enough normalized message data, adapt it instead of creating a parallel Telegram update stack.
- Keep `tg web` and `tg guard start` behavior distinct: browsing configuration is not the same as running automation.
- The first implementation plan should split backend runtime/storage from Web UI so the rule engine can land and be tested before the UI is complete.
