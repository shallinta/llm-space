import { describe, expect, test } from "bun:test";

import { createHighlightSegments } from "./static-highlight";

describe("static syntax highlighting", () => {
  test("preserves Markdown exactly while producing highlighted ranges", () => {
    const source = "**bold** and `code`";
    const segments = createHighlightSegments(source, "markdown");

    expect(segments.some((segment) => segment.classes.length > 0)).toBe(true);
    expect(segments.map((segment) => segment.text).join("")).toBe(source);
  });

  test("preserves JSON as text so React remains responsible for escaping", () => {
    const source = '{"unsafe":"<script>"}';
    const segments = createHighlightSegments(source, "json");

    expect(segments.some((segment) => segment.classes.length > 0)).toBe(true);
    expect(segments.map((segment) => segment.text).join("")).toBe(source);
  });

  test("handles empty and malformed inputs", () => {
    expect(createHighlightSegments("", "markdown")).toEqual([]);
    const malformed = '{"still": [1, 2}';
    expect(
      createHighlightSegments(malformed, "json")
        .map((segment) => segment.text)
        .join("")
    ).toBe(malformed);
  });

  test("fills classless gaps in multiline Markdown", () => {
    const source = "# Heading\n\nplain words\n\n- **bold**";
    const segments = createHighlightSegments(source, "markdown");

    expect(segments.map((segment) => segment.text).join("")).toBe(source);
    expect(segments.some((segment) => segment.classes.length === 0)).toBe(true);
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index - 1]?.classes).not.toEqual(segments[index]?.classes);
    }
  });
});
