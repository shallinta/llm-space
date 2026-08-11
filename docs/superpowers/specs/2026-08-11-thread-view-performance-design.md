# Thread View Performance Design

## Summary

Long threads and multiple open thread tabs currently keep every
`ThreadPlayground` React tree mounted. Each tree owns both the running thread
state and its visible editors, so hiding an inactive pane preserves a run but
also preserves thousands of DOM nodes, CodeMirror instances, observers, drag
sensors, and focusable controls. Global overlay work then scales with all of
that retained UI.

This change separates a thread's durable in-process session from its disposable
view, retains only the most recently used thread views, adds an on-demand
syntax-highlighted message renderer, and makes two ordinary dropdown menus
non-modal. It preserves background runs, pending persistence, undo history, and
the existing rule that a running tab cannot be closed.

## Goals

- Keep a thread run alive and receiving events when its React view is evicted.
- Remount an evicted view from the same in-memory store with complete current
  messages, run status, and undo/redo history.
- Bound mounted thread views with an LRU capacity that defaults to three and is
  configurable under General settings.
- Add an `On Demand` rendering mode that keeps static syntax highlighting while
  mounting CodeMirror only for the active editor.
- Reduce global dropdown work for Tools Add and System Prompt Examples without
  regressing pointer, keyboard, or focus behavior.
- Measure the result against a repeatable baseline using isolated desktop data.

## Non-goals

- Trace tabs do not participate in the thread-view LRU and retain their current
  lifecycle.
- The LRU does not limit open tabs or background sessions.
- LRU recency is not persisted across application restarts.
- This change does not virtualize the active message list.
- Dialogs such as Settings, Variables, New Thread, and confirmations remain
  modal.
- On Demand does not map a click in static highlighted DOM to the equivalent
  CodeMirror character offset.

## Terminology

- **Tab:** the persistent open-tab record and chrome entry.
- **Session:** the headless in-process owner of a thread store, run, persistence,
  and thread data. It exists from tab open until tab close or application exit.
- **View:** the mounted `ThreadPlayground` React UI bound to a Session.
- **Cached view:** an inactive View retained by the LRU for fast switching.
- **Evicted view:** an open Tab whose Session exists but whose View is unmounted.

## Current Constraints

`ThreadTabPane` currently owns file loading, debounced persistence, transport,
run lifecycle callbacks, and the `ThreadPlayground`. `ThreadPlayground` creates
its Zustand store inside the view. Consequently, unmounting the pane also
destroys the store and the React subscription that forwards streaming changes
to persistence.

Inactive panes are currently rendered and hidden with CSS. This preserves their
stores but also preserves their full DOM. The implementation cannot simply
filter `RuntimePaneHost` without first moving store ownership and event handling
out of the disposable view.

## Architecture

### Thread Session Registry

The desktop thread-tab layer will own a registry keyed by stable `paneId`. Each
open thread tab has exactly one Session entry. A Session contains:

- the `ThreadStore` created for that thread;
- load state and the latest loaded thread;
- runtime-aware transport and tool execution dependencies;
- current path and runtime metadata;
- serialized persistence and pending-write state;
- refresh and file-mutation coordination;
- lifecycle hooks for run start, run settlement, and host integrations;
- a synchronous view-commit callback while a View is mounted.

A lightweight headless session host remains mounted for every open thread tab.
It performs the work currently tied to `ThreadTabPane`: loading, store creation,
thread-store event subscription, persistence, refresh, rename/compaction wiring,
and cleanup. It publishes the Session through a registry/context that a View can
consume without recreating the store.

Provider/model/runtime callbacks used by `createThreadStore` remain live through
refs owned by the session host. Provider-profile state needed to resolve a run
also stays on the Session side rather than disappearing with an evicted View.

### Thread View Host

The visible pane host is split into:

- the existing Trace pane path, which is unchanged and always follows the
  current behavior; and
- a Thread View host that renders only pane IDs selected by the LRU.

`ThreadTabView` receives a Session, provides its existing `ThreadStore` through
`ThreadStoreContext`, and renders `ThreadPlaygroundContent`. Mounting a View does
not reread the file and does not create a store. Unmounting a View does not
abort the store or remove its subscriptions.

Loading and fatal-load errors are Session state. An active loading Session shows
the existing skeleton. A fatal load error retains the current toast-and-close
behavior.

### LRU Rules

The cache capacity is an integer from 1 through 10 and defaults to 3.

- Only `type: "thread"` tabs count toward the capacity.
- The active Thread View is always included.
- Activating a Thread marks it most recently used.
- A newly opened active Thread is most recently used.
- When capacity is exceeded, the least recently active inactive Thread View is
  evicted.
- Changing capacity applies immediately. Reducing it evicts excess inactive
  Views after committing their drafts.
- Closing a Tab removes its View and Session from the LRU/registry.
- Renaming or moving a Thread preserves `paneId`, so the same Session and LRU
  identity survive the path rewrite.
- Trace tabs neither consume capacity nor alter Thread recency.
- On restart, only the active Thread View is initially mounted. The cache fills
  as the user activates other Thread tabs during that process lifetime.

The LRU is implemented as pure selection/update functions with deterministic
unit tests. React components receive the selected pane-ID set rather than
embedding recency policy in render branches.

### Safe View Eviction

An editor can hold a draft that has not yet reached the Thread Store. Eviction
must not rely on a browser blur event because React may remove the focused DOM
before blur is delivered.

Each mounted View registers a synchronous `commitView()` with its Session. The
callback commits every active CodeEditor/textarea draft to the existing Store.
The LRU host calls it before removing a pane ID from the mounted-view set. Normal
Tab close and application cleanup retain the existing serialized persistence
flush behavior after Store-level drafts have been committed.

Eviction never invokes `abort()`. A running Session may have no mounted View;
its async loop, event reduction, status changes, tool results, and persistence
continue normally. Re-activation binds the View to that same Store snapshot.

The existing close guard remains authoritative: a running Tab cannot be closed.
The user can stop the run, then close the Tab. Application exit remains the only
process-wide terminal lifecycle.

## Settings

### Cached Thread Views

Add a persisted UI preference using the shared local-storage registry.

- Label: `Cached thread views`
- Location: General, immediately below `Rendering`
- Control: numeric select with values 1 through 10
- Default: 3
- Hint: `Maximum recently used thread views kept mounted. Background sessions keep running after a view is released.`

Invalid, missing, or out-of-range stored values resolve to 3. Changing the value
updates the active LRU immediately.

### Rendering

Extend `RenderingFidelity` with a third persisted value for On Demand. Existing
`rich` and `lite` values remain valid, and missing/unknown values continue to
resolve to Full so existing users see no silent behavior change.

The three labels and semantics are:

- `Full`: every repeated message editor mounts CodeMirror.
- `On Demand`: repeated editors render static Lezer syntax highlighting and
  mount one CodeMirror only after activation.
- `Fast`: repeated editors use the existing plain textarea renderer with no
  syntax highlighting.

The Rendering row hint will say:

> Full keeps every message editor mounted. On Demand shows lightweight syntax
> highlighting and activates an editor after focus; editing at a specific
> position may require a second click. Fast uses plain text for the lowest
> overhead.

The anti-FOUC `.lite` class continues to apply only to Fast. On Demand retains
normal motion and is not treated as Lite in CSS.

## On Demand Static Highlighting

### Scope

On Demand applies to repeated editor surfaces in messages and tool-call
input/output. Fixed-count editing surfaces such as System Prompt remain regular
CodeMirror instances.

### Rendering

A reusable on-demand editor component has two states:

1. **Preview:** parse the value with the applicable Lezer parser, traverse it
   with `highlightTree`, and render escaped text plus themed highlight spans in
   a `<pre>`-style surface. Text remains selectable and copyable.
2. **Editing:** mount the existing CodeEditor with the same value, extensions,
   readonly state, callbacks, and keyboard behavior.

The preview is memoized by value, language, and theme. Message text uses the
current Markdown parser; structured tool content uses its applicable parser.
No raw HTML from message content is inserted.

### Activation and Focus

An editable preview is keyboard focusable and exposes textbox semantics.

- Pointer click, Enter, or Space activates editing.
- The mounted CodeMirror receives focus.
- The activation click is not translated into an exact document offset. The
  first click activates/focuses; placing the caret at a specific location may
  require a second click.
- Blur commits the draft and returns to Preview.
- Activating a second repeated editor commits and deactivates the first.
- Deactivating or evicting a Thread View commits and returns all on-demand
  editors to Preview.
- Readonly/running previews do not activate editing.

CodeMirror-only affordances such as cursor placement, autocomplete, and prompt
variable editing extensions become available after activation. Static preview
must preserve text selection, copying, wrapping, height caps, placeholder
display, and visual syntax colors.

## Non-modal Dropdowns

Set `modal={false}` only on:

- Tools `Add`;
- System Prompt `Examples`.

Radix retains menu roles, roving keyboard focus, item selection, Escape, and
outside dismissal. The non-modal setting avoids the modal path's global
`aria-hidden`, focus trap, pointer lock, and scroll lock. Popper positioning and
the portal remain.

Regression coverage must verify:

- pointer and Enter/Space opening;
- ArrowUp/ArrowDown navigation and item selection;
- Escape closes and restores focus to the trigger;
- outside interaction closes without double-activating a background control;
- a menu item that opens a Dialog transfers focus to that Dialog instead of
  restoring it to the menu trigger.

If focus restoration conflicts with a newly opened Dialog, prevent only that
menu close's automatic focus restoration and let the Dialog own focus. Do not
turn actual Dialogs non-modal.

## Failure Handling and Cleanup

- Invalid cached-view settings fall back to 3.
- A missing Session for an active Thread is treated as a lifecycle bug and
  renders a bounded error state rather than constructing a second store.
- Store/run errors continue through the current UI and persistence paths even
  when no View is mounted.
- A Session removed by Tab close commits its mounted View, discards its registry
  entry, and runs existing persistence cleanup.
- Refresh recreates the Session store intentionally while preserving stable Tab
  identity and provider-profile selections as current behavior requires.
- LRU policy never performs file I/O and never controls abort/disconnect.

## Testing Strategy

### Unit and Component Tests

- Pure LRU behavior: activation order, capacity, shrink, active retention,
  removal, rename identity, and Trace exclusion.
- Setting parsing/persistence: default 3, accepted 1-10, invalid fallback, and
  immediate update.
- Session/View lifecycle: eviction unmounts View but retains the exact Store;
  remount observes messages and history added while absent.
- Background run: a transport continues emitting into an evicted Session and
  completes without a View.
- Draft safety: Full, On Demand, and Fast drafts commit before eviction.
- Rendering compatibility: Full, On Demand, and Fast select the intended
  renderer and old stored values remain valid.
- On Demand: highlighted preview, safe escaping, pointer/keyboard activation,
  one active repeated editor, blur commit, readonly behavior, and tab
  deactivation.
- Dropdown accessibility: pointer, keyboard, Escape/focus restoration, outside
  dismissal, and menu-to-Dialog focus transfer.
- Existing running-tab close tests remain unchanged and passing.

### Repository Verification

Run the focused tests during each red/green cycle, then run:

- `mise run test`
- `mise run lint`
- `mise run typecheck`
- `mise run build:canary`

## Performance Benchmark

Before implementation, run the benchmark at the current base commit. After
implementation, run the same benchmark on the feature branch.

The benchmark uses `mise run dev:cef` with an isolated temporary
`LLM_SPACE_HOME` and generated non-sensitive fixtures. The standard long Thread
contains 54 messages; the multi-tab scenario opens 10 equivalent Threads and
sets cached views to 3.

For Full, On Demand, and Fast where available, collect multiple samples and
report the median plus slower-tail sample for:

- mounted DOM node count;
- CodeMirror and textarea instance count;
- cached-view tab-switch time;
- evicted-view remount time;
- click-to-mounted time for Settings, Tools Add, Examples, and Variables;
- scrolling frame duration for the long active Thread.

Separately verify that a Session whose View is evicted can receive a complete
stream, persist its resulting Thread, and show the full result when remounted.

The comparison report will distinguish:

- benefit from bounding mounted Views;
- benefit from On Demand versus Full and Fast;
- benefit from non-modal ordinary menus;
- remount cost introduced by LRU eviction;
- any remaining active-long-thread cost that requires later virtualization.

The benchmark must not read real workspace files or settings. Temporary runtime
data and processes are removed after the run.

## Acceptance Criteria

- At most the configured number of ordinary Thread Views are mounted.
- Open Thread Sessions are not bounded by the View cache.
- An evicted running Thread completes and remounts with complete messages and
  the same undo/redo history.
- No typed draft is lost when a View is evicted.
- Running Tabs remain non-closable.
- On Demand displays static syntax highlighting and clearly communicates its
  focus-before-edit tradeoff in Settings.
- Tools Add and Examples retain pointer and keyboard behavior with
  `modal={false}`.
- Invalid cache settings safely use 3.
- Focused tests and full repository verification pass.
- A reproducible before/after benchmark and analysis are delivered.
