#!/usr/bin/env node
// A stateful fake adb for taphound-flash tests. The device state lives in the
// JSON file named by FAKE_ADB_STATE and changes with each command, so a whole
// flash run can be replayed against a tiny model of the demo app.
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const statePath = process.env.FAKE_ADB_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const out = (text) => process.stdout.write(text);
const PKG = "dev.taphound.demo";

// Screens: element trees with bounds [l, t, r, b]; `on` maps an id to the
// screen a tap on it opens.
const screens = {
  main: {
    activity: ".MainActivity",
    nodes: [
      { id: "open_search", text: "Search", clickable: true, bounds: [100, 300, 980, 420] },
      {
        id: "settings_row", clickable: true, bounds: [0, 1000, 1080, 1200],
        children: [
          { text: "Settings", bounds: [40, 1050, 340, 1150] },
          { id: "favorite_toggle", desc: "Favorite", clickable: true, bounds: [440, 1050, 640, 1150] }
        ]
      },
      { text: "Twin", clickable: true, bounds: [100, 1400, 500, 1500] },
      { text: "Twin", clickable: true, bounds: [600, 1400, 980, 1500] }
    ],
    on: { open_search: "search", settings_row: "settings", favorite_toggle: "favorited" }
  },
  search: {
    activity: ".SearchActivity",
    nodes: [
      { id: "search_input", clickable: true, focusable: true, bounds: [100, 200, 980, 320] },
      { id: "submit_search", text: "Submit", clickable: true, bounds: [100, 400, 980, 520] }
    ],
    on: { search_input: "search", submit_search: "submitted" }
  },
  submitted: {
    activity: ".SearchActivity",
    nodes: [{ desc: "__QUERY__", bounds: [100, 600, 980, 700] }],
    on: {}
  },
  settings: { activity: ".MainActivity", nodes: [{ id: "settings_title", text: "Settings", bounds: [100, 100, 980, 200] }], on: {} },
  favorited: { activity: ".MainActivity", nodes: [{ id: "favorite_on", bounds: [100, 100, 980, 200] }], on: {} }
};

function escape(value) {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");
}

function xmlFor(nodes, pkg) {
  return nodes.map((node) => {
    const [l, t, r, b] = node.bounds;
    const desc = node.desc === "__QUERY__" ? `submitted query=${state.typed}` : (node.desc ?? "");
    const attrs = `resource-id="${node.id === undefined ? "" : `${pkg}:id/${node.id}`}" text="${escape(node.text ?? "")}" `
      + `content-desc="${escape(desc)}" package="${pkg}" clickable="${node.clickable === true}" `
      + `enabled="true" focused="${node.id === "search_input" && state.focused}" bounds="[${l},${t}][${r},${b}]"`;
    return node.children === undefined
      ? `<node ${attrs} />`
      : `<node ${attrs}>${xmlFor(node.children, pkg)}</node>`;
  }).join("");
}

/** A loading label that changes on every dump for `launchFrames` dumps after launch. */
function loading() {
  if (state.launchFrames === undefined || state.frame >= state.launchFrames) return "";
  state.frame += 1;
  return `<node resource-id="" text="Loading ${state.frame}" content-desc="" package="${PKG}" clickable="false" enabled="true" bounds="[0,1800][1080,1900]" />`;
}

function hierarchy() {
  if (!state.awake || state.keyguard || !state.running) {
    return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">`
      + `<node resource-id="com.android.systemui:id/keyguard" text="" content-desc="" package="com.android.systemui" clickable="false" enabled="true" bounds="[0,0][1080,1920]" /></hierarchy>`;
  }
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">`
    + `<node resource-id="" text="" content-desc="" package="${PKG}" clickable="false" enabled="true" bounds="[0,0][1080,1920]">`
    + `${xmlFor(screens[state.screen].nodes, PKG)}${loading()}</node></hierarchy>`;
}

/** Deepest element with a transition whose bounds contain the point. */
function hit(nodes, x, y) {
  for (const node of nodes) {
    const [l, t, r, b] = node.bounds;
    if (x < l || x >= r || y < t || y >= b) continue;
    return hit(node.children ?? [], x, y) ?? (node.id !== undefined && node.id in screens[state.screen].on ? node.id : undefined);
  }
  return undefined;
}

const args = process.argv.slice(2);
if (args[0] === "devices") {
  out(`List of devices attached\n${state.online ? "FAKE123\tdevice\n" : ""}`);
  process.exit(0);
}
if (args[0] !== "-s" || args[1] !== "FAKE123") {
  process.stderr.write("error: device not found\n");
  process.exit(1);
}
const [kind, ...rest] = args.slice(2);
const command = rest.join(" ");
state.log.push(`${kind} ${command}`);

if (kind === "exec-out" && rest[0] === "cat") out(hierarchy());
else if (kind === "exec-out" && rest[0] === "screencap") out("PNG-BYTES");
else if (kind === "logcat") out(state.crashed ? "FATAL EXCEPTION: main\njava.lang.IllegalStateException: boom\n" : "");
else if (command === `pm path ${PKG}`) out(state.installed ? "package:/data/app/demo/base.apk\n" : "");
else if (command === "dumpsys power") out(`  mWakefulness=${state.awake ? "Awake" : "Asleep"}\n`);
else if (command === "dumpsys window") {
  out(`    isKeyguardShowing=${state.keyguard}\n`);
  if (state.running && state.awake && !state.keyguard) {
    out(`  mCurrentFocus=Window{1 u0 ${PKG}/${PKG}${screens[state.screen].activity}}\n`);
  }
} else if (command === "dumpsys activity activities") {
  if (state.running) out(`  topResumedActivity=ActivityRecord{9 u0 ${PKG}/${screens[state.screen].activity} t5}\n`);
} else if (command === "input keyevent 224") state.awake = true;
else if (command === "wm dismiss-keyguard") {
  if (!state.secureLock) state.keyguard = false;
} else if (command === `am force-stop ${PKG}`) state.running = false;
else if (command.startsWith("am start") || command.startsWith("monkey")) {
  Object.assign(state, { running: true, screen: "main", focused: false, typed: "", frame: 0 });
  out("Status: ok\n");
} else if (command === `pidof ${PKG}`) out(state.running ? "4242\n" : "");
else if (command.startsWith("uiautomator dump")) {
  // The first `dumpFailures` dumps hit the startup window of the
  // accessibility bridge, as a cold launch does on real devices.
  if ((state.dumpFailures ?? 0) > 0) {
    state.dumpFailures -= 1;
    out("ERROR: null root node returned by UiTestAutomationBridge.\n");
  } else {
    out("UI hierchary dumped to: /sdcard/taphound-flash.xml\n");
  }
}
else if (rest[0] === "input" && rest[1] === "tap") {
  const [x, y] = [Number(rest[2]), Number(rest[3])];
  state.taps.push([x, y]);
  const id = hit(screens[state.screen].nodes, x, y);
  if (id === state.crashOnTap) {
    Object.assign(state, { running: false, crashed: true });
  } else if (id !== undefined) {
    if (id === "search_input") state.focused = true;
    state.screen = screens[state.screen].on[id];
  }
} else if (rest[0] === "input" && rest[1] === "text") {
  if (state.focused) state.typed += rest[2].replaceAll("%s", " ").replace(/\\(.)/g, "$1");
} else if (command === "input keyevent 4") {
  state.screen = state.screen === "main" ? state.screen : "main";
  state.focused = false;
}
save();
