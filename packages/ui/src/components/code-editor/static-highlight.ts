import { jsonLanguage } from "@codemirror/lang-json";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { classHighlighter, highlightTree } from "@lezer/highlight";

export interface HighlightSegment {
  text: string;
  classes: string[];
}

export type HighlightLanguage = "markdown" | "json";

interface HighlightRange {
  from: number;
  to: number;
  classes: string[];
}

function _sameClasses(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((className, index) => className === right[index])
  );
}

/** Parse text with Lezer and return React-safe text segments, including gaps. */
export function createHighlightSegments(
  source: string,
  language: HighlightLanguage
): HighlightSegment[] {
  if (!source) return [];

  const parser =
    language === "json" ? jsonLanguage.parser : markdownLanguage.parser;
  const ranges: HighlightRange[] = [];
  highlightTree(parser.parse(source), classHighlighter, (from, to, classes) => {
    if (to > from) {
      ranges.push({
        from,
        to,
        classes: classes.split(/\s+/).filter(Boolean),
      });
    }
  });
  ranges.sort((left, right) => left.from - right.from || left.to - right.to);

  const segments: HighlightSegment[] = [];
  const append = (text: string, classes: string[]) => {
    if (!text) return;
    const previous = segments.at(-1);
    if (previous && _sameClasses(previous.classes, classes)) {
      previous.text += text;
    } else {
      segments.push({ text, classes });
    }
  };
  let cursor = 0;
  for (const range of ranges) {
    const from = Math.max(cursor, range.from);
    const to = Math.max(from, range.to);
    if (from > cursor) {
      append(source.slice(cursor, from), []);
    }
    if (to > from) {
      append(source.slice(from, to), range.classes);
      cursor = to;
    }
  }
  if (cursor < source.length) {
    append(source.slice(cursor), []);
  }
  return segments;
}
