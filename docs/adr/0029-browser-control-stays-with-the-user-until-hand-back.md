# 0029: Browser control stays with the user until Hand back

Status: Accepted

Date: 2026-10-14

Amends the control paragraph of
[ADR-0018](0018-use-the-visible-preview-for-agent-browser-automation.md).

## Context

ADR-0018 gave control to the user on direct input and left the release implicit.
Once the user's input stopped, the next agent effect took the page back. A user
who clicked to fix something mid-run lost the page to the agent's next turn,
and nothing on screen said who was in charge.

## Decision

- The hold is per thread. The holder is the agent, the user, or nobody.
- Taking control, by direct page input or the Take control pill, makes the user
  the holder. Only the Hand back action releases a user hold. Sending a
  message, ending a turn, or a quiet page does not.
- While the user holds, the broker refuses every effect operation with
  `HUMAN_INTERRUPTED`. `inspect` and `status` stay allowed and never claim
  control, so Plan mode never shows the agent as acting.
- Each tab has a control epoch. Taking control, Hand back, and a turn ending
  advance it. An effect that carries an older epoch is refused with
  `STALE_CONTROL_EPOCH`. The agent learns the current epoch from `inspect`.
  Nothing is replayed after Hand back.
- The toolbar shows who acts. The agent pill ("Take control") appears only while
  an effect runs and for three seconds after the last one. The "Hand back" pill
  appears for as long as the user holds. The agent keeps its hold between
  effects; the pill is a presentation of recent activity, not of the hold.

## Consequences

The reducer in `packages/shared/src/browser-preview/browser-control.ts` is the
single source of these rules. Desktop and the web runtime both follow it, and
neither adds its own release path. A new way to start a turn must not call
Hand back.
