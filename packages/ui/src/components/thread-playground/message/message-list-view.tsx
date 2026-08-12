import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  type DragEndEvent,
  type DragStartEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { AssistantMessage, Message, ThreadContext } from "@llm-space/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { PlusIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "@llm-space/ui/lib/utils";
import { Button } from "@llm-space/ui/ui/button";
import { ScrollArea } from "@llm-space/ui/ui/scroll-area";
import { ShineBorder } from "@llm-space/ui/ui/shine-border";

import {
  type RunValidationIssue,
  useThreadStore,
  useThreadStoreActions,
} from "../stores";

import {
  ImageDisplayProvider,
  type ImageDisplayContextValue,
} from "./image-display-context";
import { MessageListItem } from "./message-list-item";
import { resolveMessageMove } from "./message-move";
import { MessageNavigator } from "./message-navigator";
import { findCenteredVirtualItemIndex } from "./virtual-item-center";

const MESSAGE_ESTIMATED_HEIGHT = 240;
const MESSAGE_OVERSCAN = 3;
const DND_MODIFIERS = [restrictToVerticalAxis];

export interface ThreadScrollSnapshot {
  messageId: string | null;
  offset: number;
  scrollTop: number;
}

export interface ScrollAnchorMeasurement {
  id: string;
  top: number;
  bottom: number;
}

export function captureThreadScrollSnapshotFromMeasurements(
  scrollTop: number,
  viewportTop: number,
  anchors: readonly ScrollAnchorMeasurement[]
): ThreadScrollSnapshot {
  const anchor = anchors.find(({ bottom }) => bottom > viewportTop);
  return {
    messageId: anchor?.id ?? null,
    offset: anchor ? anchor.top - viewportTop : 0,
    scrollTop,
  };
}

export function resolveThreadScrollTop(
  snapshot: ThreadScrollSnapshot,
  currentScrollTop: number,
  viewportTop: number,
  anchors: readonly ScrollAnchorMeasurement[]
): number {
  const anchor = anchors.find(({ id }) => id === snapshot.messageId);
  return anchor
    ? currentScrollTop + anchor.top - viewportTop - snapshot.offset
    : snapshot.scrollTop;
}

function _getScrollViewport(content: HTMLElement | null): HTMLElement | null {
  return (
    content?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ??
    null
  );
}

function _measureMessageAnchors(content: HTMLElement): ScrollAnchorMeasurement[] {
  return Array.from(
    content.querySelectorAll<HTMLElement>("[data-message-id]")
  ).map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      id: element.dataset.messageId ?? "",
      top: rect.top,
      bottom: rect.bottom,
    };
  });
}

function _captureThreadScrollSnapshot(
  viewport: HTMLElement,
  content: HTMLElement
): ThreadScrollSnapshot {
  return captureThreadScrollSnapshotFromMeasurements(
    viewport.scrollTop,
    viewport.getBoundingClientRect().top,
    _measureMessageAnchors(content)
  );
}

function _restoreThreadScrollSnapshot(
  snapshot: ThreadScrollSnapshot,
  viewport: HTMLElement,
  content: HTMLElement
): void {
  viewport.scrollTop = resolveThreadScrollTop(
    snapshot,
    viewport.scrollTop,
    viewport.getBoundingClientRect().top,
    _measureMessageAnchors(content)
  );
}

export function MessageListView({
  className,
  context: contextFromProps,
  messages: messagesFromProps,
  readonly: readonlyFromProps = false,
  compactImages = false,
  measurementsFrozen = false,
  active = false,
  initialScrollSnapshot = null,
  onScrollSnapshotChange,
}: {
  className?: string;
  context?: ThreadContext;
  messages?: Message[];
  readonly?: boolean;
  /** Render image attachments as `[Image #N]` placeholders. */
  compactImages?: boolean;
  /** Keep measured heights while an ancestor is hidden. */
  measurementsFrozen?: boolean;
  /** Whether this live Thread View is currently visible. */
  active?: boolean;
  /** One-shot View-local position restored after an LRU remount. */
  initialScrollSnapshot?: ThreadScrollSnapshot | null;
  /** Captures position when the View leaves the active state. */
  onScrollSnapshotChange?: (snapshot: ThreadScrollSnapshot) => void;
}) {
  const isSnapshotView = messagesFromProps !== undefined;
  const status = useThreadStore((s) => s.status);
  const collapsedMessageIds = useThreadStore((s) => s.collapsedMessageIds);
  const pendingAutoFocusMessageId = useThreadStore(
    (s) => s.pendingAutoFocusMessageId
  );
  const runValidationIssue = useThreadStore((s) => s.runValidationIssue);
  const storeMessages = useThreadStore((s) => s.thread.context?.messages);
  const { appendMessage, moveMessage, resolveRunValidationIssue } =
    useThreadStoreActions();
  const [dragging, setDragging] = useState(false);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [activeMessageIndex, setActiveMessageIndex] = useState<number | null>(
    null
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const messages = useMemo(
    () => messagesFromProps ?? storeMessages ?? [],
    [messagesFromProps, storeMessages]
  );
  const readonly = readonlyFromProps || isSnapshotView;
  const messageIds = useMemo(
    () => messages.map((message) => message.id),
    [messages]
  );
  const collapsedMessageIdSet = useMemo(
    () => new Set(collapsedMessageIds),
    [collapsedMessageIds]
  );
  const getMessageKey = useCallback(
    (index: number) => messages[index]?.id ?? index,
    [messages]
  );
  const getScrollElement = useCallback(
    () =>
      contentRef.current?.closest<HTMLElement>(
        '[data-slot="scroll-area-viewport"]'
      ) ?? null,
    []
  );
  // TanStack Virtual exposes a mutable imperative controller by design.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: messages.length,
    estimateSize: () => MESSAGE_ESTIMATED_HEIGHT,
    getItemKey: getMessageKey,
    getScrollElement,
    overscan: MESSAGE_OVERSCAN,
    paddingStart: 12,
    useCachedMeasurements: measurementsFrozen || dragging,
    onChange: (instance) => {
      const viewportHeight = instance.scrollRect?.height ?? 0;
      if (viewportHeight <= 0) {
        return;
      }
      const index = findCenteredVirtualItemIndex(
        instance.getVirtualItems(),
        instance.scrollOffset ?? 0,
        viewportHeight
      );
      setActiveMessageIndex((current) => (current === index ? current : index));
    },
  });
  const addMessageSuggested =
    runValidationIssue?.resolution?.type === "appendUserMessage";

  const imageDisplay = useMemo<ImageDisplayContextValue>(() => {
    const numbers = new Map<string, number>();
    let count = 0;
    for (const message of messages) {
      message.content.forEach((content, contentIndex) => {
        if (content.type === "image") {
          count += 1;
          numbers.set(`${message.id}:${contentIndex}`, count);
        }
      });
    }
    return {
      compact: compactImages,
      numberOf: (messageId, contentIndex) =>
        numbers.get(`${messageId}:${contentIndex}`) ?? 0,
    };
  }, [messages, compactImages]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );
  const activeMessage = useMemo(
    () => messages.find((message) => message.id === activeMessageId) ?? null,
    [activeMessageId, messages]
  );
  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveMessageId(String(event.active.id));
    setDragging(true);
  }, []);
  const handleDragCancel = useCallback(() => {
    setActiveMessageId(null);
    setDragging(false);
  }, []);
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveMessageId(null);
      setDragging(false);
      const move = resolveMessageMove(
        messageIds,
        String(event.active.id),
        event.over ? String(event.over.id) : null
      );
      if (move) moveMessage(move.sourceIndex, move.destinationIndex);
    },
    [messageIds, moveMessage]
  );
  const restoredScrollRef = useRef(false);
  const scrollToBottom = useCallback(() => {
    const viewport = getScrollElement();
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [getScrollElement]);
  const jumpToMessage = useCallback(
    (index: number) => {
      setActiveMessageIndex(index);
      virtualizer.scrollToIndex(index, {
        align: "center",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      });
    },
    [virtualizer]
  );

  useEffect(() => {
    if (!measurementsFrozen) {
      virtualizer.measure();
    }
  }, [measurementsFrozen, virtualizer]);
  useEffect(() => {
    if (status === "running") {
      scrollToBottom();
    }
  }, [status, scrollToBottom]);
  useEffect(() => {
    if (!pendingAutoFocusMessageId) {
      return;
    }
    const index = messages.findIndex(
      (message) => message.id === pendingAutoFocusMessageId
    );
    if (index >= 0) {
      virtualizer.scrollToIndex(index, { align: "auto" });
    }
  }, [messages, pendingAutoFocusMessageId, virtualizer]);
  useEffect(() => {
    if (!runValidationIssue?.messageId) {
      return;
    }
    const index = messages.findIndex(
      (message) => message.id === runValidationIssue.messageId
    );
    if (index >= 0) {
      virtualizer.scrollToIndex(index, { align: "auto" });
    }
  }, [messages, runValidationIssue, virtualizer]);

  // The active View is always retained. Capture once as it transitions to
  // inactive, before its ancestor becomes `display: none`; no scroll listener
  // or Store update is needed while the user scrolls.
  useLayoutEffect(() => {
    if (!active || isSnapshotView || !onScrollSnapshotChange) return;
    const content = contentRef.current;
    return () => {
      const viewport = _getScrollViewport(content);
      if (content && viewport) {
        onScrollSnapshotChange(
          _captureThreadScrollSnapshot(viewport, content)
        );
      }
    };
  }, [active, isSnapshotView, onScrollSnapshotChange]);

  // A retained hidden View keeps its DOM scrollTop. This only does work for a
  // View recreated after LRU eviction. A newly appended/inserted message owns
  // focus and scrolling, so its one-shot autofocus takes precedence.
  useLayoutEffect(() => {
    if (restoredScrollRef.current || !active || isSnapshotView) return;
    if (pendingAutoFocusMessageId) {
      restoredScrollRef.current = true;
      return;
    }
    const content = contentRef.current;
    const viewport = _getScrollViewport(content);
    if (initialScrollSnapshot && content && viewport) {
      _restoreThreadScrollSnapshot(initialScrollSnapshot, viewport, content);
    }
    restoredScrollRef.current = true;
  }, [
    active,
    initialScrollSnapshot,
    isSnapshotView,
    pendingAutoFocusMessageId,
  ]);

  const virtualItems = virtualizer.getVirtualItems();
  const firstVirtualItem = virtualItems[0];
  const showNavigator = messages.length > 1;

  return (
    <div className={cn("relative size-full", className)}>
      <ScrollArea type="auto" className="size-full">
        <ImageDisplayProvider value={imageDisplay}>
          <div ref={contentRef} className="p-3 pt-0.5">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={DND_MODIFIERS}
              onDragStart={handleDragStart}
              onDragCancel={handleDragCancel}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={messageIds}
                strategy={verticalListSortingStrategy}
              >
                <div
                  className="relative w-full"
                  style={{ height: virtualizer.getTotalSize() }}
                >
                  <div
                    className="absolute top-0 left-0 w-full"
                    style={{
                      transform: `translateY(${firstVirtualItem?.start ?? 0}px)`,
                    }}
                  >
                    {virtualItems.map((virtualItem) => {
                      const message = messages[virtualItem.index];
                      if (!message) {
                        return null;
                      }
                      return (
                        <div
                          key={virtualItem.key}
                          ref={virtualizer.measureElement}
                          className="w-full"
                          data-index={virtualItem.index}
                        >
                          <SortableMessageRow
                            context={contextFromProps}
                            message={message}
                            readonly={readonly}
                            autoFocus={
                              message.id === pendingAutoFocusMessageId
                            }
                            collapsed={collapsedMessageIdSet.has(message.id)}
                            runValidationIssue={
                              message.id === runValidationIssue?.messageId
                                ? runValidationIssue
                                : null
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              </SortableContext>
              <DragOverlay>
                {activeMessage ? (
                  <div className="pb-3.5 opacity-95">
                    <MessageListItem
                      context={contextFromProps}
                      message={activeMessage}
                      readonly
                      collapsed={collapsedMessageIdSet.has(activeMessage.id)}
                    />
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
            {!isSnapshotView ? (
              <StreamingMessageListItem streaming={status === "running"} />
            ) : null}
            <div className="relative rounded-lg">
              <Button
                className={cn(
                  "text-muted-foreground hover:text-accent-foreground w-full justify-start rounded-lg py-5 hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_2%)]!",
                  dragging && "invisible",
                  readonly && "hidden"
                )}
                disabled={readonly}
                variant="secondary"
                size="lg"
                onClick={
                  addMessageSuggested
                    ? resolveRunValidationIssue
                    : appendMessage
                }
              >
                <PlusIcon className="size-4" />
                Add message
              </Button>
              {addMessageSuggested && !dragging && !readonly ? (
                <>
                  <ShineBorder
                    borderWidth={1}
                    duration={14}
                    shineColor="var(--primary)"
                  />
                  <ShineBorder
                    borderWidth={1}
                    duration={14}
                    shineColor="var(--primary)"
                    style={{ animationDelay: "-7s" }}
                  />
                </>
              ) : null}
            </div>
          </div>
        </ImageDisplayProvider>
      </ScrollArea>
      {showNavigator ? (
        <MessageNavigator
          activeIndex={activeMessageIndex}
          messages={messages}
          onJump={jumpToMessage}
        />
      ) : null}
    </div>
  );
}

const _SortableMessageRow = function SortableMessageRow({
  context,
  message,
  readonly,
  autoFocus,
  collapsed,
  runValidationIssue,
}: {
  context?: ThreadContext;
  message: Message;
  readonly: boolean;
  autoFocus: boolean;
  collapsed: boolean;
  runValidationIssue: RunValidationIssue | null;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: message.id, disabled: readonly });
  const dragHandleProps = useMemo(
    () => ({ attributes, listeners: listeners ?? {}, setActivatorNodeRef }),
    [attributes, listeners, setActivatorNodeRef]
  );
  return (
    <div
      ref={setNodeRef}
      className="pb-3.5"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        visibility: isDragging ? "hidden" : undefined,
      }}
    >
      <MessageListItem
        context={context}
        message={message}
        readonly={readonly}
        autoFocus={autoFocus}
        collapsed={collapsed}
        runValidationIssue={runValidationIssue}
        dragHandleProps={dragHandleProps}
      />
    </div>
  );
};
const SortableMessageRow = memo(_SortableMessageRow);

function StreamingMessageListItem({ streaming }: { streaming: boolean }) {
  let streamingMessage: AssistantMessage | null = useThreadStore(
    (state) => state.streamingMessage
  );
  if (!streamingMessage && streaming) {
    streamingMessage = {
      id: "streaming",
      role: "assistant",
      content: [],
    };
  }
  if (!streamingMessage) {
    return null;
  }
  return (
    <MessageListItem
      className="mb-3.5"
      message={streamingMessage}
      readonly
      streaming
    />
  );
}
