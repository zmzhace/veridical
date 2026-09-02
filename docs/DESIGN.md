# Veridical Interface System

## Direction

The interface follows a calm, task-first desktop application model: warm neutral surfaces, compact typography, stable navigation, quiet borders, and one obvious action per view. It borrows the restraint of Codex without reproducing its branding.

The product must not look like a collection of admin cards. Lists are preferred for dense resources; drawers are preferred for optional context; the canvas is reserved for topology-changing decisions.

## Tokens

| Role           | Value                 |
| -------------- | --------------------- |
| App background | `#F7F7F5`             |
| Surface        | `#FFFFFF`             |
| Primary text   | `#1F1F1D`             |
| Secondary text | `#6F6F69`             |
| Border         | `#E5E5E0`             |
| Accent         | `#5B5BD6`             |
| Focus ring     | accent at low opacity |
| Radius         | 6–10px                |

Use a 4/8px spacing rhythm. Control heights are 32, 36, or 40px. Shadows only communicate elevation for a drawer or floating menu. Gradients, neon treatments, emoji icons, oversized pills, and nested cards are not part of the system.

## Layout rules

- Global navigation contains only Agents, Tasks, and Settings.
- Agent App uses task list plus conversation; artifacts and approvals open in a drawer.
- Studio uses palette, canvas, and inspector. Tool, Skill, MCP, Memory, model, and output configuration live inside the Agent inspector unless they change graph topology.
- Capability Settings uses a compact, searchable list. A row answers name, purpose, source/version, risk, and availability before it is opened.
- Forms use short labels, concise helper copy, visible focus, inline validation, and a persistent action area on laptop-height viewports.

## Interaction states

All interactive surfaces implement idle, hover, focus-visible, disabled, loading, empty, error, offline, revoked, and success states. Dialogs trap focus, close with Escape, and return focus to their trigger. Destructive actions name the affected object and provide a recovery path where possible.

Streaming output grows in one Assistant message. Auto-scroll stops when the reader moves upward and resumes only when they choose “back to latest”. Runtime activity uses natural language; raw event names are available only in Trace.

## Responsive behavior

- `≥1280px`: full desktop layout.
- `900–1279px`: optional context becomes a drawer.
- `<900px`: navigation and task list collapse; conversation remains primary.
- Studio below desktop width supports inspection and basic edits, while complex graph editing explains the desktop requirement.

## Review checklist

- The primary action is visible without scrolling at 1280×720.
- No screen requires understanding Spec, MCP schemas, or hashes for the common path.
- Focus order follows visual order and all controls have an accessible name.
- Long Chinese and English labels truncate or wrap without moving critical actions.
- Loading does not cause large layout shifts.
- Mock capabilities are clearly labeled and never appear as production-ready.
