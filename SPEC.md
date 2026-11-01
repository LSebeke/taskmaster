# Taskmaster: implementation spec

Obsidian plugin for a solo engineer managing several projects. Gantt-first. Answers at a glance: where do I stand, am I on plan, what do I work on next, do I need to cut scope.

Reference implementation of behaviour and UI: `prototype/taskmaster-prototype.html`. Open it by double-click. The `<script id="engine">` block is pure and validated: port it to TypeScript as the scheduler. The rest of the file is a throwaway shell, so copy behaviour, not code. Where this spec and the prototype differ, this spec wins.

**Specified here but not in the prototype:** real notes and everything that writes to them (creating, moving, renaming, trashing, frontmatter), persistence, the timer, drag-to-link dependencies, backlinks in the rail, Obsidian's note picker, the settings tab, browsing plan history, Obsidian theme integration.

**Prototype-only, do not build:** `+1 day`, Reset, Stress, the Theme button and the Scenarios tab. The prototype's fake vault list and the `Would open note` message stand in for real notes.

## Scope

**v1:** desktop Obsidian, one user, many projects, unlimited nesting.

**Not in v1:** multi-user, money, Kanban, calendar sync, mobile, automatic re-planning.

## Glossary

| Term | Meaning |
|---|---|
| **Item** | A note managed by the plugin. All work is one kind of item, at any depth |
| **Parent** | An item with children. Dates and hours roll up from them. Its own hours figure is its budget |
| **Project** | An item with no parent |
| **Task** | An item with no children and hours above 0. Only tasks are scheduled, consume capacity and appear in priority lists |
| **Draft** | An item with no children and no hours. Listed, not scheduled, marked `○ no hrs` |
| **Milestone** | A separate kind: zero hours, cannot have children, must have a parent, drawn as a diamond. Its date is its pin, else when its dependencies finish. Done once that date has passed |
| **External** | Dated event outside your control, such as machine maintenance. No hours, no capacity. Work can depend on it |
| **To-do** | Untimed checkbox attached to a task. Never on the Gantt, never in the scheduler |
| **Forecast** | Live schedule. Recalculated on every change |
| **Plan** | Frozen snapshot of dates and hours per item. Changes only through Update plan |
| **Burn** | Hours per day flowing into a task |
| **Tier** | Set of tasks with equal priority |
| **Capacity** | Weekly hours, spread evenly across working days |

Whether an item is a parent, task or draft is derived, never stored. Milestone and External are stored kinds. Untimed work you just want to tick off is a to-do on a task.

## Storage

The vault is the source of truth. One note per item, folders mirroring the hierarchy for tidiness.

```yaml
# Projects/Sensor Gateway v2/Firmware/Drivers/CAN stack port.md
---
tm-type: item            # item | milestone | external
tm-parent: "[[Drivers]]"
tm-deps: ["[[CAN transceiver debug]]"]
tm-estimate: 30          # original hours, for estimate accuracy
tm-left: 22              # hours remaining
tm-left-updated: 2026-11-02
tm-log: ["2026-11-02 3.5", "2026-11-03 4"]   # date, hours
tm-started: 2026-11-02   # set when work actually reaches the task
tm-pin-start: 2026-11-16 # optional
tm-pin-end: 2026-11-18   # optional
tm-scope: must           # must | should | could
tm-notes: ["[[Vendor call notes]]"]
---
Free-form notes.

- [ ] Check common-mode choke footprint
- [x] Scope termination at 1 Mbit
```

Rules:

- `tm-parent` and `tm-deps` are the source of truth, not folders. Links in frontmatter survive renames and show up as backlinks.
- Spent hours derive from `tm-log`. Done date derives from `tm-left` reaching 0.
- To-dos are the checkboxes in the note body.
- Any item may have `tm-deadline`. Parents may have `tm-budget` (hours). Milestones record `tm-done` with the date they passed.
- External items use `tm-pin-start` and `tm-pin-end` (both required) and live in `<projects folder>/_external/`. They have no `tm-parent`.
- The projects folder is a setting, default `Projects/`.
- Linked notes are `tm-notes` links. Plain links elsewhere also work: the rail shows `tm-notes` and backlinks.
- Priority tiers, plans, plan history, capacity and holidays live in `_taskmaster/state.json` in the vault. They are cross-item, and rewriting many notes on a drag would be slow and noisy in sync. Write atomically.
- Plan entries are keyed by note path and rewritten on rename.

## Scheduler

Pure function of items, tiers, settings and today. No Obsidian imports. Time step is one day; hours within a day are fluid.

Each task's start and end are independently **Auto** or **Pinned**.

| Start | End | Behaviour |
|---|---|---|
| Auto | Auto | Released when predecessors finish. Dates follow burn |
| Pinned | Auto | Released on the pin regardless of predecessors. End follows hours and burn |
| Auto | Pinned | Start is the latest release day that still finishes by the pin, given all parallel work (binary search over the simulation). This answers "when must I start?" |
| Pinned | Pinned | Constant burn: `left / working days` from `max(pin, today)` to the pin. Reserved before priorities apply |

Each working day:

1. Capacity = weekly hours / 5. Mon to Fri, minus holidays.
2. Take reserved burn for both-pinned tasks. A negative remainder is overbooked and clamps to 0.
3. Pass remaining capacity to released tasks, highest tier first. A tier shares equally, with hours a task cannot use redistributed inside the tier. The tier takes everything before the next tier sees any.
4. A finished task releases successors the same day, so leftover hours keep flowing.

The simulation starts today. Past work is what was logged. Hours are never allocated to the past. Stop at 4 years and report anything unfinished.

**Dependencies** are finish-to-start. A dependency on a parent means all its tasks. A task also waits for the dependencies of every ancestor. Cross-project dependencies are allowed. Reject cycles in the UI, including cycles a move or new item would create. A dependency on a draft is ignored until the draft has hours or children, so nothing waits on it. A milestone that depends only on drafts lands on today.

**Priority:** tiers ("priority levels") are one global ordered list. Project lists are filtered views of it.

- Tasks in one level share burn equally. A higher level goes first.
- Order inside a level is display only. It must never change the forecast.
- Levels are created and removed only by explicit user action. A drag never creates one. A level stays when its last task leaves and is removed with its Remove button. Only empty levels can be removed.
- New tasks join the last level.

**Pins never move.** A violated pin raises a conflict:

- Pinned start before a predecessor finishes: red link, conflict.
- Pinned end out of reach: conflict showing forecast end. Pin marker stays on its date, bar runs to forecast end.
- Pinned window in the past with hours left: conflict, remaining hours land on the first available day.
- Reserved burn above capacity: overbooked marker on the load strip, conflict.

**External items:**

- Never in the hierarchy, never moved, no children, no dependencies of their own.
- Take no hours and no capacity, and never appear in priority lists.
- Any task, parent or milestone can depend on one, across projects. Dependents start the working day after its end date, or later if capacity says so. A dependency on a parent does the same for all its tasks.
- Dates are facts you maintain. Changing them moves the forecast at once. They have no plan entry and Update plan ignores them. Their effect on the plan shows as dependents slipping.
- They do not extend any project's dates, rollups or finish.
- A pinned start inside the outage is a conflict, not a move.
- An unfinished external item can sit on the critical chain. Finished ones cannot delay anything.

**Structure changes:**

- First child: the item's hours (spent + left) become its budget unless it has one. Left goes to 0, pins clear, it leaves the priority lists. Its first new child takes its priority level. Hours already logged on it stay counted in the rollup. Its dependencies, deadline, notes and to-dos stay.
- Last child removed or moved away: the budget becomes hours again (`left = budget - spent`, floored at 0) and the item returns to the last priority level.
- If that leaves it with logged hours and nothing left, it counts as done.
- Moving keeps the item's pins, dependencies, priority and subtree. It never changes any plan: rollups and `vs plan` change, plan entries wait for Update plan.
- Children can be added to any item except milestones and external items. Hours are logged on tasks only. Parents have no pins and do not drag.

**Hours:**

- Logging moves hours from left to spent. Total hours stay the same.
- Logging never moves a bar. On a task that has not started, start stays where the schedule puts it.
- Actual start (`tm-started`) is set the first time work flows into the task on or after its forecast start, or when today reaches that start with hours logged.
- Editing a log entry adjusts hours left by the difference, so total stays the same. Deleting an entry is the same as editing it to 0: hours return to left.
- Setting total hours sets `left = total - spent`, floored at 0. Left at 0 marks the task done. Raising it reopens the task and returns it to the last priority level.
- `tm-estimate` stays as the original estimate for accuracy. Editing total does not change it.

**Critical chain:** per project, start at the last-finishing task and walk back. If the task sat idle while released, follow to the task that took the hours (capacity link, dashed). Otherwise follow to the latest-finishing predecessor. Stop at work finished before today, or when neither applies. Chains may cross projects.

## Plan and forecast

- Forecast changes live with hours, capacity, priority and pins. The plan does not.
- **Update plan** works at any level. Its top-bar button names its target. With a row selected, the target is that row. With nothing selected, or an external item selected, the target is the rows at the current level. Details panels also have the button.
- The dialog lists each row with old and new end, each with a checkbox, plus "Also update their sub-levels" (default on, shown when a row has children).
- Never modify anything above the target.
- Each parent keeps its own plan. If child plans outgrow it, show a warning with the gap in working days and hours.
- Every update appends to plan history with the prior values.
- Plan and Forecast each have a visibility of Off, Ghost or Solid. Each level holds at most one layer. Picking a taken level swaps the two layers. Default: Plan Solid, Forecast Ghost.

## Metrics

| Metric | Definition |
|---|---|
| Done % | `spent / (spent + left)`, rolled up over hours |
| Plan says today | Hours-weighted share of each leaf's plan window elapsed, in working days |
| vs plan | Working days between plan end and forecast end |
| Past deadline | Working days between deadline and forecast end |
| Projected total | `spent + left`, compared to budget, else plan hours |
| Unallocated budget | `budget - (spent + left)` when positive. Not scheduled. Rail warns that finish dates look earlier than they will be |
| Estimate ratio | Actual over estimate on finished tasks in the project |
| Adjusted finish | Rerun with `left × ratio` for that project's tasks |
| Stale | In-progress task whose `tm-left` was not updated for 7 days (a setting) |

**MVP signal**, for projects with a deadline. Rerun the schedule with could-haves removed, then with should-haves also removed. Show all three finish dates against the deadline, the hours each option saves, and one verdict:

1. Full scope makes it.
2. Drop could-haves.
3. MVP mode: must-haves only.
4. Even must-haves miss: change the plan.

## UI

Layout: top bar, optional legend, hierarchy column, canvas timeline, load strip beneath it, right rail, status bar. See the prototype.

**Top bar, left to right:** Up, breadcrumb, `+ Project`, `+ Item`, Plan visibility, Forecast visibility, zoom (Q, M, W), axis (Date, CW), View menu, Update plan, Undo.

**Status bar:** what the last change did to the forecast (how many tasks moved, the largest moves), conflict count, weekly capacity. Hovering a legal drop target shows the consequence here. Capacity is editable in place, and also in settings with holidays, stale days and the projects folder.

**Keyboard and mouse:** N adds an item. Ctrl+Z undoes. Ctrl+wheel zooms around the cursor. Esc closes an open form or dialog, then clears selection, then goes up.

**Navigation:** a prominent Up button at the far left of the top bar, disabled at the top. Breadcrumb beside it. Esc clears selection, then goes up. Drill-down is explicit: Focus button on a parent row (on hover) or in its details.

**Hierarchy column, left to right:**

- Eye toggle, in a fixed column at the very left of the screen, always in the same position. Hides the row and its subtree from the chart. Hiding is display only: hidden work still schedules and counts. A header control shows the hidden count and lists hidden rows so they can be restored.
- Indent.
- Collapse button, at least 28 by 24 px.
- Title, Done %, vs plan.
- On hover, parent rows show `+ Add` and `⤢ Focus`, and childless rows `+ Add`, in place of the Done and vs-plan columns.

vs-plan markers: `✓ 0d`, `▲ +3d` behind plan, `▼ -2d` ahead, `▲ 7d` past deadline (takes precedence), `✓ done`, `● new` not in the plan, `○ no hrs` draft. External rows show `ext`, or `past` once finished. A row with a conflict shows `⚠` before its title.

Clicking anywhere else on a row or bar only selects it and opens it in the rail. It never changes the view.

**Timeline:** Today line, labelled. Bar fill shows done %. Ghost lane sits under each bar. Deadline flag on rows with a deadline. Pinned edges marked. Critical chain in red: an underline on solid forecast bars, a red ghost bar when Forecast is Ghost. Dependency links attach to the forecast lane, or to plan bars when Forecast is off. Bars are coloured by project, in fixed order. Non-working days shaded. Tooltip on hover, with every value also reachable in the rail. Time axis toggles between dates and ISO calendar weeks (CW45).

**View menu:** every element except complete/remaining can be hidden: external items, Today line, dependencies, critical chain, capacity links, deadlines, pinned edges, milestones, weekend shading, gridlines, load strip, Done and vs-plan columns, conflict markers, legend, right rail, status bar, hide toggles, and the ghost layer. **Clean for sharing** hides all of them in one click and turns the other layer off, keeping whichever of Plan or Forecast is solid. The top bar stays. **Default** restores everything, with Plan Solid and Forecast Ghost. Capacity links are off by default.

**Bar interactions:**

| Gesture | Result |
|---|---|
| Click bar or row | Select, open in rail |
| Double-click | Open note |
| Drag forecast body | Pin both edges |
| Drag forecast edge | Pin that edge |
| Drag from dot on bar to another bar | Add dependency (not in prototype) |

Dragging recalculates live. Only forecast bars of unfinished tasks and external bars drag, in Ghost or Solid. Plan bars, parents and milestones do not. An edge cannot be dragged past the other edge. Each edge has an Auto/Pinned switch in the rail.

**External section:** a labelled section at the bottom of the hierarchy and chart, sorted by start, with neutral-coloured bars taller than task bars. In a focused view it lists only items referenced by what is shown. Dependency links are drawn to their dependents. Selecting one shades its dates across the whole chart. Bars drag to change dates. The eye toggle and the View menu hide them.

**Load strip:** stacked weekly hours per project, capacity line, marker on overbooked weeks.

**Rail, overview** (nothing selected, or a parent selected): status, hours left, done vs plan, spent vs budget, projected total, `+ Add`, Focus, Update plan, unallocated-budget warning, plan-gap warning, count of items not yet in the plan, MVP signal (projects only), estimate accuracy, linked notes, properties (name, budget, deadline, Inside), to-dos if it has any, delete, then upcoming external items, next-up list, conflicts and stale tasks. At the top level: per-project summary, then the same lists.

**Rail, task:** status, conflicts, done vs plan and hours tiles, plain-language reason for its dates (milestones and drafts too), Update plan, name, Inside, deadline, Auto/Pinned per edge, total hours, hours left, log hours with date, editable log entries, timer, priority level, scope, dependencies, to-dos, notes, delete. Drafts show the same panel, so hours can be added there.

**Creating items:** `+ Project` and `+ Item` in the top bar, `+ Add` on item rows (on hover) and in details, and the N key. All open one form in the rail.

- The form offers Item, Milestone or External. External asks for name, start and end. Item fields: name, parent (Top level means a project), hours, deadline, scope, priority, pins, dependencies. Milestones have a pin date and dependencies.
- Name is required. Hours are optional: an item with neither hours nor children is a draft. Milestones need a parent.
- Choosing a parent that has hours shows that they will become its budget.
- The form defaults its parent to the selected parent item, else the selected item's parent, else the focused item. New items default to the last priority level, unless they are the first child of a task.
- Add keeps the form open for the next item. Enter submits. After adding a project, the form continues inside it. An option makes the next item depend on the one just added.
- Each item creates a note: a task at `<parent folder>/<title>.md`. An item that gains children becomes `<parent folder>/<title>/<title>.md`, moving its note. Title clashes get a suffix.
- New items join the forecast at once and stay out of the plan. They show `● new`, a ghost forecast bar and no plan bar. The rail counts them until Update plan includes them.

**Moving items:** two ways, both with the same rules.

- Drag a row in the hierarchy column. Top quarter of a target places before it, bottom quarter after it, middle moves inside it. The target shows an insertion line or outline, and the consequence appears before the drop, including hours becoming a budget. Illegal targets refuse the drop and say why.
- The Inside picker in details lists the tree. Top level makes the item a project.

Refused: moving into itself or a descendant, into a milestone or external item, a milestone to top level, moving an external item, anything that creates a dependency loop. A move rewrites `tm-parent` and moves the note to match.

**Editing items:** rename, deadline, and budget on parents, are in details. Rename also renames the note. Delete asks for a second click showing the item count, removes the subtree, its dependencies and priority entries, and moves notes to Obsidian's trash. Undo restores it within the session.

**Add dependency:** picker with candidates listed under their parent path. Paths and items sorted alphabetically. Items that would create a cycle are left out.

**Link note:** a Link control in every details panel opens Obsidian's fuzzy note picker. Offer to create the note if nothing matches. Unlink with one click.

**Rail, external:** name, start, end, effect, what it blocks with add and remove, notes, delete. Effect reruns the schedule without the item and shows how many working days later each blocked item starts, and how much later each project finishes. Show both: a project finish can stay put while a blocked item's start slips, because other work takes the hours. The overview lists upcoming external items in scope. A waiting task's explanation names the external item and its end date.

**Rail, to-do:** one overall list and a list per project, the project list following the focused project. Each priority level is a visibly separate box with a header, showing task count and equal burn. Rows show open to-dos, hours left and burn. Each task expands to its to-dos, which can be ticked and added. Ticks write back to the note.

Drag behaviour must make the consequence obvious before the drop, and must not shift layout during the drag:

- All levels show a dashed outline while dragging.
- Same level: neutral highlight, insertion line, banner "Order only: schedule stays the same".
- Other level: strong warning highlight, insertion line, banner "Moves to Priority N: changes who gets hours".
- Dropping outside a level does nothing.

"+ above" on each level and "+ New priority level at the bottom" create levels. Priority can also be set from a dropdown in task details, listing existing levels only.

**Next-up:** unblocked tasks in tier order, critical first, limit 5.

**Timer:** one running task, persisted across reloads, writes a log entry on stop, prompts for hours left. Show it in the status bar.

**Dark and light** both follow Obsidian's theme, using its CSS variables for chrome. Categorical and status colours are in the prototype's CSS. Status never relies on colour alone: always a glyph or label.

Undo covers every edit in the session, including creating, moving and deleting. Add commands for: open Taskmaster, new project, new task under current note, start/stop timer, log hours.

## Performance

These are requirements, tested in CI where possible.

| Measure | Budget |
|---|---|
| Plugin `onload` | < 5 ms. Register the view and commands only. Defer all work to `onLayoutReady` and first view open |
| View open, 500 items | < 100 ms to first full paint |
| Recalculate, 200 tasks | < 16 ms |
| Recalculate, 1,000 tasks | < 50 ms |
| Scroll, pan, zoom | 60 fps, no recalculation |

Prototype baseline: about 20 ms analysis at 1,000 tasks with no end-pinned tasks (Node and headless Chromium), draw about 4 ms. At the 34-item demo with one end-pinned task, 1 to 5 ms with an 11 ms peak, draw 1 to 4 ms.

End-pinned tasks each trigger a binary search of full simulations and are the main cost. The MVP signal, adjusted finish and external effect each rerun the schedule, so compute them only for the panel on screen. Cache by input hash. If a project reaches the budget, move the search to a Web Worker and keep the last result on screen. Do not show a spinner during drag.

## Architecture

TypeScript, esbuild, `manifest.json` with `isDesktopOnly: true`. Canvas for the timeline, windowed DOM for the hierarchy column, Preact for the rail. No charting or Gantt library.

| Module | Responsibility |
|---|---|
| `engine/` | Pure scheduling, rollups, plan, metrics, MVP. Ported from prototype. No Obsidian imports |
| `store/` | Reads items from `metadataCache`, reacts to its events, applies edits with `fileManager.processFrontMatter` and `vault.process`, owns `state.json` |
| `view/gantt/` | Canvas, hit-testing, drag |
| `view/rail/` | Rail panels |
| `view/` | `ItemView`, layout, commands |

Read items from `metadataCache`, never by reading files, at boot. Writes must be debounced per file, and a change from the plugin must not trigger a second recalculation when the cache event returns. Verify every Obsidian API named here against the current `obsidian.d.ts`.

## Build order

Each step ends in something usable.

1. Engine port with the acceptance cases below.
2. Store: read-only projection of notes into the engine.
3. Read-only Gantt with hierarchy and rail overview.
4. Editing: hours, logs, pins, dependencies, drag.
5. Creating, moving, renaming, deleting. External items.
6. Priority lists and to-dos.
7. Plan layer, Update plan, visibility, View menu.
8. MVP signal, estimate accuracy, stale flags, next-up, external effect, timer.
9. Performance pass against the budgets.

## Acceptance cases

Today Mon 2 Nov 2026, 30 h/week (6 h/day), no holidays, unless stated.

| Setup | Expected |
|---|---|
| a 12h, b 12h tied | Both end Thu 5 Nov, 3 h/day each |
| a 12h ranked above b 12h | a ends Tue 3 Nov. b runs Wed 4 to Thu 5 Nov |
| a 3h, then b 3h depending on a | Both end 2 Nov |
| a 12h, start pinned Thu 5 Nov | 5 Nov to Fri 6 Nov |
| a 12h, end pinned Fri 13 Nov | Starts Thu 12 Nov |
| a 12h end pinned 13 Nov, tied with b 60h | a starts Tue 10 Nov (burn halves) |
| a 10h pinned 2 to 6 Nov, b 20h | a reserves 2 h/day. b gets 4 h/day, ends 6 Nov |
| a 16h pinned 2 to 2 Nov | Overbooked conflict |
| a 60h ranked above b 6h, b depends on a, b start pinned 3 Nov | b stays on 3 Nov. Conflict on b |
| a 60h, end pinned 3 Nov | Conflict: pin out of reach |
| a 12h ranked above b 12h | Critical chain a to b, capacity link |
| Levels `[[a,b],[c]]`, move c to level 0 | `[[a,b,c],[]]`: emptied level stays |
| Levels `[[a,b],[c]]`, move c to level 0 before b | `[[a,c,b],[]]` |
| Same tasks, level order `[a,b,c]` vs `[c,b,a]` | Identical forecast |
| Empty levels added between `[a]` and `[b]` | Identical forecast |
| Remove a non-empty level | Refused |
| Log 3h on unstarted b (12h) | b's start unchanged. Spent 3, left 9 |
| Then edit that entry to 1h | Spent 1, left 11 |
| Then delete it | Spent 0, left 12 |
| Spent 2, set total 20 | Left 18 |
| Spent 2, set total 1 | Left 0, done. Set total 10: left 8, reopened |
| Create item with no hours | Draft: listed, not scheduled, not done, no MVP signal |
| Create milestone with no parent | Refused |
| Create item, no level given | Joins last level. Forecast changes, no plan changes |
| Task with 16h, 2h logged, dep on x, gets first child | Budget 16, left 0, spent still 2 in rollup. Child waits for x and takes its priority level |
| Delete or move the last child | Parent has `left = budget - spent` and is scheduled again |
| Move an item | Parent budgets, plans and pins unchanged. Rollups change. Sibling order respected |
| Move into own descendant, into a milestone, or creating a loop | Refused with a message |
| Delete a parent | Subtree, its plan entries, priority entries and dependencies on it all gone |
| a 12h depends on external item 2 to 4 Nov | a starts Thu 5 Nov. Capacity unchanged |
| Same, external end moved to Mon 9 Nov | a starts Tue 10 Nov. No plan entry changes |
| External end before today | No delay |
| Effect of an external item | Compares blocked items' starts with a schedule that excludes the item |
| External item with no dependents, dated after a project's end | Project finish unchanged, no capacity used |
| Task pinned to start inside an external item it depends on, including its last day | Start stays, conflict raised |
| Same, pinned to the day after it ends | No conflict |
| Dependency on a draft | Ignored. Dependent is scheduled |
| Move an external item, or move anything into one | Refused |
| Update plan at top level | External items unaffected |
| Update plan on children of a parent, deep | Parent and its ancestors unchanged. Parent reports plan gap |
| Update plan with a nested parent selected, deep | That item and its subtree change. Ancestors unchanged |

Prototype scenarios (Scenarios tab) double as manual acceptance tests.

## Decisions to confirm

Built into the prototype as defaults, cheap to change before implementation.

1. **Update plan reaches downward by default**, unless "Also update their sub-levels" is unticked.
2. **A pinned start does not raise priority.** A low-priority task pinned to start Monday can sit idle if higher levels take all capacity. It shows as blocked by capacity.
3. **End-pinned tasks obey their level.** Only both-pinned tasks reserve capacity. An end-pinned task in too low a level gets a conflict, not a boost.
4. **Default equal burn means parallel work.** Tasks in one level split the week evenly, so forecasts assume heavy context switching until you separate them.
5. **Budget not broken into tasks uses no capacity.** The rail warns instead. The alternative is scheduling it as a placeholder task.
6. **`state.json` under Obsidian Sync** requires syncing other file types. Git and Syncthing are unaffected.
7. **The eye toggle** is read as display-only hiding, separate from collapsing.
8. **An item with hours and no children is scheduled, even a project.** A project given 60h and nothing inside it competes for time as one 60h block.
9. **Deleting the last child schedules the budget.** Remove every task from a 90h project and it becomes 90h of work.
10. **External items keep no plan.** The original date of a maintenance window is not recorded, only its effect on dependents.
11. **External items only block what is linked.** Nothing warns about a task that uses the machine but is not linked to it.
