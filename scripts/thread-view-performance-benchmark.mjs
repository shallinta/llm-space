#!/usr/bin/env bun
/* global Bun */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = Bun.argv.slice(2);
const label = readFlag("--label", "benchmark");
const outputPath = readFlag(
  "--output",
  join(tmpdir(), `llm-space-thread-view-${label}.json`)
);
const smoke = readFlag("--smoke", null);
const samples = Number(readFlag("--samples", smoke ? "1" : "5"));
const port = 9400 + (process.pid % 200);
const root = await mkdtemp(join(tmpdir(), "llm-space-thread-view-"));
const workspace = join(root, "workspace");
let child;

try {
  await mkdir(workspace, { recursive: true });
  for (let index = 1; index <= 10; index += 1) {
    await writeFile(
      join(workspace, `benchmark-${String(index).padStart(2, "0")}.json`),
      JSON.stringify(createThread(index), null, 2)
    );
  }

  child = Bun.spawn(["mise", "run", "dev:cef"], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      LLM_SPACE_HOME: root,
      LLM_SPACE_DESKTOP_CDP_PORT: String(port),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const logs = collectLogs(child);
  await waitForCdp(port, child, logs);
  const cdp = await CdpClient.connect(port);
  try {
    await prepareApp(cdp);
    await openFixtureThreads(cdp);

    if (smoke === "dropdowns") {
      const dropdowns = await smokeDropdowns(cdp);
      const result = { label, smoke, dropdowns };
      await Bun.write(outputPath, JSON.stringify(result, null, 2));
      if (!dropdowns.toolsAdd.nonModal || !dropdowns.examples.nonModal) {
        throw new Error(
          `Dropdown smoke expected non-modal menus: ${JSON.stringify(result)}`
        );
      }
      console.info(JSON.stringify({ outputPath, ...result }, null, 2));
      process.exitCode = 0;
    } else {
      const full = await measureMode(cdp, "rich", samples);
      const fast = await measureMode(cdp, "lite", samples);
      const onDemandSupported = await cdp.evaluate(
        `(() => localStorage.getItem("llm-space-rendering-fidelity") === "on-demand")()`
      );
      const onDemand = onDemandSupported
        ? await measureMode(cdp, "on-demand", samples)
        : null;
      const result = {
        label,
        baseCommit: await git("rev-parse", "main"),
        benchmarkCommit: await git("rev-parse", "HEAD"),
        renderer: "cef",
        fixture: { threads: 10, messagesPerThread: 54 },
        samples,
        full,
        fast,
        onDemand,
      };
      await Bun.write(outputPath, JSON.stringify(result, null, 2));
      console.info(JSON.stringify({ outputPath, ...result }, null, 2));
    }
  } finally {
    cdp.close();
  }
} finally {
  if (child) await stopChild(child);
  await rm(root, { recursive: true, force: true });
}

function createThread(threadIndex) {
  const messages = Array.from({ length: 54 }, (_, index) => ({
    id: `benchmark-${threadIndex}-message-${index + 1}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: [
      {
        type: "text",
        text: [
          `## Benchmark message ${index + 1}`,
          "",
          "A deterministic paragraph with **Markdown**, `inline code`, and a template variable {{current_date}}.",
          "",
          "```json",
          JSON.stringify({ thread: threadIndex, message: index + 1 }),
          "```",
        ].join("\n"),
      },
    ],
  }));
  return {
    title: `benchmark-${String(threadIndex).padStart(2, "0")}`,
    context: {
      systemPrompt: "You are a deterministic performance fixture.",
      messages,
    },
  };
}

async function prepareApp(cdp) {
  await cdp.evaluate(`(() => {
    localStorage.setItem("llm-space-rendering-fidelity", "lite");
    localStorage.setItem("llm-space:thread-view-cache-size", "3");
    localStorage.removeItem("llm-space:open-app-tabs");
    localStorage.removeItem("llm-space:active-tab");
    location.reload();
    return true;
  })()`);
  await waitFor(cdp, `document.readyState === "complete"`, 10_000);
  await sleep(500);
  await cdp.evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const close = dialog && [...dialog.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Close");
    close?.click();
    return true;
  })()`);
}

async function openFixtureThreads(cdp) {
  for (let index = 1; index <= 10; index += 1) {
    const title = `benchmark-${String(index).padStart(2, "0")}`;
    await waitFor(
      cdp,
      `document.querySelector('[aria-label="${title}"]') !== null`,
      15_000
    );
    await cdp.evaluate(
      `document.querySelector('[aria-label="${title}"]')?.click()`
    );
    await waitFor(
      cdp,
      `document.querySelector('[aria-label="Close ${title}"]') !== null`,
      15_000
    );
  }
  await waitFor(
    cdp,
    `document.querySelectorAll('[data-message-id]').length >= 54`,
    20_000
  );
}

async function measureMode(cdp, mode, sampleCount) {
  await cdp.evaluate(`(() => {
    localStorage.setItem("llm-space-rendering-fidelity", ${JSON.stringify(mode)});
    location.reload();
    return true;
  })()`);
  await waitFor(cdp, `document.readyState === "complete"`, 10_000);
  await waitFor(
    cdp,
    `document.querySelectorAll('[data-message-id]').length >= 54`,
    30_000
  );
  if (mode === "rich") {
    await waitFor(cdp, `document.querySelectorAll('.cm-editor').length > 0`, 30_000);
  }
  await sleep(500);
  const counts = await cdp.evaluate(`(() => ({
    dom: document.querySelectorAll("*").length,
    codeMirror: document.querySelectorAll(".cm-editor").length,
    textareas: document.querySelectorAll("textarea").length,
    messages: document.querySelectorAll("[data-message-id]").length,
    mountedThreadViews: Math.ceil(document.querySelectorAll("[data-message-id]").length / 54),
  }))()`);
  const metrics = {};
  for (const target of ["settings", "toolsAdd", "examples", "variables"]) {
    const values = [];
    for (let index = 0; index < sampleCount; index += 1) {
      values.push(await measureOverlay(cdp, target));
      await sleep(120);
    }
    metrics[target] = summarize(values);
  }
  return { counts, metrics };
}

async function measureOverlay(cdp, target) {
  return cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const fire = (element) => {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        const EventType = type.startsWith("pointer") ? PointerEvent : MouseEvent;
        element.dispatchEvent(new EventType(type, {
          bubbles: true,
          button: 0,
          buttons: type.endsWith("down") ? 1 : 0,
          pointerType: "mouse",
        }));
      }
    };
    const closeOpen = () => {
      const dialog = document.querySelector('[role="dialog"]');
      const close = dialog && [...dialog.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Close");
      const closeSlot = dialog?.querySelector('[data-slot="dialog-close"]');
      (closeSlot ?? close)?.click();
      const openMenu = document.querySelector('[data-slot="dropdown-menu-content"]');
      if (openMenu) {
        const target = document.activeElement ?? document;
        target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        target.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true }));
      }
    };
    closeOpen();
    await sleep(100);
    const target = ${JSON.stringify(target)};
    let trigger;
    let selector;
    if (target === "settings") {
      trigger = document.querySelector('[aria-label="Settings"]');
      selector = '[role="dialog"]';
    } else if (target === "toolsAdd") {
      trigger = [...document.querySelectorAll('button[data-slot="dropdown-menu-trigger"]')]
        .find((button) => button.textContent?.trim() === "Add");
      selector = '[data-slot="dropdown-menu-content"]';
    } else if (target === "examples") {
      trigger = [...document.querySelectorAll('button[data-slot="dropdown-menu-trigger"]')]
        .find((button) => button.textContent?.trim() === "Examples");
      selector = '[data-slot="dropdown-menu-content"]';
    } else {
      trigger = [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Add" && button.dataset.slot === "button");
      selector = '[role="dialog"]';
    }
    if (!trigger) return -1;
    const started = performance.now();
    const mounted = new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled || !document.querySelector(selector)) return;
        settled = true;
        observer.disconnect();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          resolve(performance.now() - started);
        }));
      };
      const observer = new MutationObserver(finish);
      observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        resolve(-1);
      }, 3000);
    });
    if (target === "settings" || target === "variables") trigger.click();
    else fire(trigger);
    return mounted;
  })()`);
}

async function smokeDropdowns(cdp) {
  return cdp.evaluate(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const fire = (element) => {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        const EventType = type.startsWith("pointer") ? PointerEvent : MouseEvent;
        element.dispatchEvent(new EventType(type, { bubbles: true, button: 0, pointerType: "mouse" }));
      }
    };
    const inspect = async (label) => {
      const trigger = [...document.querySelectorAll('button[data-slot="dropdown-menu-trigger"]')]
        .find((button) => button.textContent?.trim() === label);
      fire(trigger);
      await sleep(100);
      const menu = document.querySelector('[data-slot="dropdown-menu-content"]');
      const appRoot = document.querySelector("#root") ?? document.body.firstElementChild;
      const bodyLocked = getComputedStyle(document.body).overflow === "hidden";
      const result = {
        opens: Boolean(menu),
        nonModal: appRoot?.getAttribute("aria-hidden") !== "true" && !bodyLocked,
      };
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(50);
      result.escapeRestoresTrigger = document.activeElement === trigger;
      return result;
    };
    return { toolsAdd: await inspect("Add"), examples: await inspect("Examples") };
  })()`);
}

function summarize(values) {
  const valid = values.filter((value) => Number.isFinite(value) && value >= 0);
  valid.sort((left, right) => left - right);
  if (valid.length === 0) return { samples: values, median: null, max: null };
  return {
    samples: values,
    median: valid[Math.floor(valid.length / 2)],
    max: valid.at(-1),
  };
}

async function waitFor(cdp, expression, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await cdp.evaluate(`Boolean(${expression})`)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function waitForCdp(cdpPort, processHandle, logs) {
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Desktop exited before CDP was ready:\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        if (targets.some(isAppTarget)) return;
      }
    } catch {
      // App is still starting.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for CDP on ${cdpPort}:\n${logs.join("")}`);
}

function collectLogs(processHandle) {
  const chunks = [];
  for (const stream of [processHandle.stdout, processHandle.stderr]) {
    void (async () => {
      for await (const chunk of stream) {
        chunks.push(new TextDecoder().decode(chunk));
        if (chunks.length > 200) chunks.shift();
      }
    })();
  }
  return chunks;
}

async function stopChild(processHandle) {
  try {
    process.kill(-processHandle.pid, "SIGINT");
  } catch {
    if (processHandle.exitCode === null) processHandle.kill("SIGINT");
  }
  await Promise.race([processHandle.exited, sleep(5_000)]);
  try {
    process.kill(-processHandle.pid, "SIGTERM");
  } catch {
    if (processHandle.exitCode === null) processHandle.kill("SIGTERM");
  }
  await Promise.race([processHandle.exited, sleep(2_000)]);
}

async function git(...gitArgs) {
  const processHandle = Bun.spawn(["git", ...gitArgs], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(processHandle.stdout).text();
  const error = await new Response(processHandle.stderr).text();
  if ((await processHandle.exited) !== 0) throw new Error(error);
  return output.trim();
}

function readFlag(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CdpClient {
  static async connect(cdpPort) {
    const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then(
      (response) => response.json()
    );
    const candidates = targets.filter(isAppTarget).reverse();
    for (const target of candidates) {
      if (!target.webSocketDebuggerUrl) continue;
      const client = new CdpClient(target.webSocketDebuggerUrl);
      await client.ready;
      await client.send("Runtime.enable");
      await client.send("Page.enable");
      const accessible = await client.evaluate(`(() => {
        try { void localStorage.length; return location.href; }
        catch { return null; }
      })()`);
      if (accessible) return client;
      client.close();
    }
    throw new Error(`No accessible CDP app target: ${JSON.stringify(candidates)}`);
  }

  constructor(url) {
    this.socket = new WebSocket(url);
    this.pending = new Map();
    this.nextId = 1;
    this.ready = new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = reject;
    });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      const resolve = this.pending.get(message.id);
      if (!resolve) return;
      this.pending.delete(message.id);
      resolve(message);
    };
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  async evaluate(expression) {
    const message = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (message.error || message.result?.exceptionDetails) {
      throw new Error(JSON.stringify(message.error ?? message.result.exceptionDetails));
    }
    return message.result.result.value;
  }

  close() {
    this.socket.close();
  }
}

function isAppTarget(target) {
  return (
    target.type === "page" &&
    target.url?.startsWith("http://localhost:5173") &&
    target.title?.includes("LLM Space")
  );
}
