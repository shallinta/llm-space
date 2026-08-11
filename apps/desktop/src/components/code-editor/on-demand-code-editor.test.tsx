/* eslint-disable @typescript-eslint/require-await -- React act callbacks intentionally flush synchronous DOM work */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

import type {
  CodeEditorHandle,
  CodeEditorProps,
} from "@llm-space/ui/components/code-editor";
import {
  EditorCommitScope,
  type EditorCommitScopeHandle,
} from "@llm-space/ui/components/code-editor/editor-commit-scope";
import {
  OnDemandCodeEditor,
  OnDemandEditorScope,
} from "@llm-space/ui/components/code-editor/on-demand-code-editor";
import {
  act,
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type FormEvent,
} from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  installReactTestDom,
  TestElement,
  TestEvent,
} from "@/test/react-test-dom";

const TEST_DOM = installReactTestDom();
let root: Root | null = null;
let container: TestElement | null = null;

const FakeFullEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(
  function FakeFullEditor(
    { autoFocus, onBlur, onChange, value },
    forwardedRef
  ) {
    const elementRef = useRef<HTMLTextAreaElement>(null);
    const draftRef = useRef(value);
    const commit = () => onChange?.(draftRef.current);
    useImperativeHandle(forwardedRef, () => ({
      commit,
      getValue: () => draftRef.current,
      insertText: (text) => {
        draftRef.current += text;
      },
    }));
    useLayoutEffect(() => {
      if (autoFocus) elementRef.current?.focus();
    }, [autoFocus]);
    return (
      <textarea
        ref={elementRef}
        data-testid="full-editor"
        defaultValue={value}
        onBlur={() => {
          commit();
          onBlur?.();
        }}
        onInput={(event: FormEvent<HTMLTextAreaElement>) => {
          draftRef.current = event.currentTarget.value;
        }}
      />
    );
  }
);

function _preview(): TestElement | null {
  return TEST_DOM.document.body.querySelector("[data-on-demand-preview]");
}

function _editor(): TestElement | null {
  return TEST_DOM.document.body.querySelector("[data-testid=full-editor]");
}

async function _render(element: React.ReactNode) {
  await act(async () => root?.render(element));
}

beforeEach(() => {
  container = TEST_DOM.document.createElement("div");
  TEST_DOM.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

afterAll(() => TEST_DOM.restore());

describe("OnDemandCodeEditor", () => {
  test.each([
    ["Enter", "Enter"],
    ["Space", " "],
  ])("%s activates the full editor and focuses it", async (_label, key) => {
    await _render(
      <OnDemandEditorScope active>
        <OnDemandCodeEditor
          FullEditor={FakeFullEditor}
          value="**hello**"
        />
      </OnDemandEditorScope>
    );

    expect(_preview()?.getAttribute("role")).toBe("textbox");
    await act(async () => {
      _preview()?.dispatchEvent(new TestEvent("keydown", { key }));
    });

    const editor = _editor();
    if (!editor) throw new Error("Full editor did not activate");
    expect(TEST_DOM.document.activeElement).toBe(editor);
  });

  test("pointer activation edits, commits on blur, and returns to preview", async () => {
    const changes: string[] = [];
    await _render(
      <OnDemandEditorScope active>
        <OnDemandCodeEditor
          FullEditor={FakeFullEditor}
          value="before"
          onChange={(value) => changes.push(value)}
        />
      </OnDemandEditorScope>
    );

    await act(async () => {
      _preview()?.dispatchEvent(new TestEvent("pointerdown"));
    });
    const editor = _editor();
    if (!editor) throw new Error("Full editor did not activate");
    editor.value = "after";
    editor.dispatchEvent(new TestEvent("input"));
    await act(async () => editor.dispatchEvent(new TestEvent("focusout")));

    expect(changes).toEqual(["after"]);
    expect(_editor()).toBeNull();
    expect(_preview()?.textContent).toBe("after");
  });

  test("readonly previews remain selectable but never activate", async () => {
    await _render(
      <OnDemandEditorScope active>
        <OnDemandCodeEditor
          FullEditor={FakeFullEditor}
          value="readonly"
          readonly
        />
      </OnDemandEditorScope>
    );

    expect(_preview()?.getAttribute("aria-readonly")).toBe("true");
    await act(async () => {
      _preview()?.dispatchEvent(new TestEvent("pointerdown"));
      _preview()?.dispatchEvent(new TestEvent("keydown", { key: "Enter" }));
    });
    expect(_editor()).toBeNull();
  });

  test("activating another editor commits the first", async () => {
    const firstChanges: string[] = [];
    await _render(
      <OnDemandEditorScope active>
        <OnDemandCodeEditor
          FullEditor={FakeFullEditor}
          value="first"
          onChange={(value) => firstChanges.push(value)}
        />
        <OnDemandCodeEditor FullEditor={FakeFullEditor} value="second" />
      </OnDemandEditorScope>
    );

    const previews = TEST_DOM.document.body.querySelectorAll(
      "[data-on-demand-preview]"
    );
    await act(async () => previews[0]?.dispatchEvent(new TestEvent("pointerdown")));
    const firstEditor = _editor();
    if (!firstEditor) throw new Error("First editor did not activate");
    firstEditor.value = "first edited";
    firstEditor.dispatchEvent(new TestEvent("input"));
    await act(async () => {
      TEST_DOM.document.body
        .querySelector("[data-on-demand-preview]")
        ?.dispatchEvent(new TestEvent("pointerdown"));
    });

    expect(firstChanges).toEqual(["first edited"]);
    expect(_editor()).not.toBeNull();
  });

  test("the View commit scope commits an active draft", async () => {
    const changes: string[] = [];
    let scope: EditorCommitScopeHandle | null = null;
    await _render(
      <EditorCommitScope onReady={(handle) => (scope = handle)}>
        <OnDemandEditorScope active>
          <OnDemandCodeEditor
            FullEditor={FakeFullEditor}
            value="before"
            onChange={(value) => changes.push(value)}
          />
        </OnDemandEditorScope>
      </EditorCommitScope>
    );
    await act(async () => {
      _preview()?.dispatchEvent(new TestEvent("pointerdown"));
    });
    const editor = _editor();
    if (!editor) throw new Error("Full editor did not activate");
    editor.value = "committed by scope";
    editor.dispatchEvent(new TestEvent("input"));

    await act(async () => scope?.commitAll());
    expect(changes).toEqual(["committed by scope"]);
    expect(_preview()?.textContent).toBe("committed by scope");
  });
});
