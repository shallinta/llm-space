# Thread View Performance Benchmark

## Method

- Renderer: Electrobun CEF with CDP
- Fixture: 10 generated Threads, 54 Markdown/JSON messages per Thread
- Data isolation: a temporary `LLM_SPACE_HOME`; no real workspace or settings
- Repetitions: five samples per overlay metric
- Dependency state: `bun install` completed from the checked-in lockfile

## Baseline

The production UI matches `main` at
`437f297ffa95956c5a801a98c4cf10158062132e`. The harness ran from documentation
commit `7a896a63bba865eb7558e3195bc1f51cbcab8f9d`; no production source had changed.

| Rendering | Mounted views | DOM nodes | CodeMirror | Textareas |
| --- | ---: | ---: | ---: | ---: |
| Full | 10 | 49,094 | 550 | 0 |
| Fast | 10 | 31,089 | 0 | 540 |

Click-to-painted overlay timing in milliseconds:

| Rendering | Surface | Median | Maximum |
| --- | --- | ---: | ---: |
| Full | Settings | 45.5 | 275.5 |
| Full | Tools Add | 71.8 | 113.4 |
| Full | Examples | 148.9 | 161.8 |
| Full | Variables | 41.2 | 172.6 |
| Fast | Settings | 96.0 | 253.7 |
| Fast | Tools Add | 81.3 | 83.9 |
| Fast | Examples | 87.8 | 89.6 |
| Fast | Variables | 101.5 | 107.2 |

One Full/Examples sample timed out during close/reopen cycling and is excluded
from the median. Raw five-sample arrays remain in
`/tmp/llm-space-thread-view-baseline.json` for this development run.

## Final comparison

Final measurements are added by Task 9 after the production changes.
