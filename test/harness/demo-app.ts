import type { LayoutElement } from "../../src/domain/layout.js";
import type { Journey, JourneyStep } from "../../src/domain/journey.js";
import type { SimulatedApp } from "./simulated-device.js";

/**
 * A state-machine model of `examples/taphound-android-demo`: Main opens
 * Search; tapping the field focuses it, typing fills it, and submitting
 * publishes an accessibility result and a SearchViewModel log.
 */

export const DEMO_PACKAGE = "dev.taphound.demo";
export const MAIN = `${DEMO_PACKAGE}.MainActivity`;
export const SEARCH = `${DEMO_PACKAGE}.SearchActivity`;

function root(
  id: string,
  children: LayoutElement[]
): LayoutElement[] {
  return [{
    id,
    enabled: true,
    bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
    children
  }];
}

function button(
  id: string,
  resourceId: string,
  text: string,
  top: number
): LayoutElement {
  return {
    id,
    resourceId,
    text,
    enabled: true,
    clickable: true,
    bounds: { left: 100, top, right: 980, bottom: top + 120 },
    children: []
  };
}

function searchField(text: string | undefined, focused: boolean): LayoutElement {
  return {
    id: "search_input",
    resourceId: "search_input",
    ...(text === undefined ? {} : { text }),
    enabled: true,
    clickable: true,
    focusable: true,
    focused,
    bounds: { left: 100, top: 200, right: 980, bottom: 320 },
    children: []
  };
}

const submit = button("submit_search", "submit_search", "Submit", 400);

export const demoApp: SimulatedApp = {
  packageName: DEMO_PACKAGE,
  launchActivity: MAIN,
  startScreen: "main",
  screens: {
    main: {
      activity: MAIN,
      layout: root("main_root", [
        button("open_search", "open_search", "Search", 300)
      ])
    },
    search: {
      activity: SEARCH,
      layout: root("search_root", [searchField(undefined, false), submit])
    },
    searchFocused: {
      activity: SEARCH,
      layout: root("search_root", [searchField(undefined, true), submit])
    },
    searchTyped: {
      activity: SEARCH,
      layout: root("search_root", [searchField("hello world", true), submit])
    },
    searchSubmitted: {
      activity: SEARCH,
      layout: root("search_root", [
        searchField("hello world", false),
        submit,
        {
          id: "result",
          contentDescription: "submitted query=hello world",
          enabled: true,
          bounds: { left: 100, top: 600, right: 980, bottom: 700 },
          children: []
        }
      ]),
      logs: [{ tag: "SearchViewModel", message: "event=resultsReady query=hello world" }]
    }
  },
  transitions: [
    { from: "main", on: { action: "tap", elementId: "open_search" }, to: "search" },
    { from: "search", on: { action: "tap", elementId: "search_input" }, to: "searchFocused" },
    {
      from: "searchFocused",
      on: { action: "inputText", text: "hello world" },
      to: "searchTyped"
    },
    { from: "searchTyped", on: { action: "tap", elementId: "submit_search" }, to: "searchSubmitted" },
    { from: "search", on: { action: "back" }, to: "main" },
    { from: "searchFocused", on: { action: "back" }, to: "main" }
  ]
};

const openSearch: JourneyStep = {
  action: "click",
  locator: { resourceId: "open_search" },
  activity: { before: MAIN, after: SEARCH },
  expect: {
    type: "element",
    locator: { resourceId: "search_input" },
    timeoutMs: 500
  }
};

const focusField: JourneyStep = {
  action: "click",
  locator: { resourceId: "search_input" },
  activity: { before: SEARCH, after: SEARCH }
};

const typeQuery: JourneyStep = {
  action: "inputText",
  text: "hello world",
  activity: { before: SEARCH, after: SEARCH }
};

const submitQuery: JourneyStep = {
  action: "click",
  locator: { resourceId: "submit_search" },
  activity: { before: SEARCH, after: SEARCH },
  expect: {
    type: "element",
    locator: { contentDescription: "submitted query=hello world" },
    timeoutMs: 500
  }
};

function journey(name: string, steps: JourneyStep[]): Journey {
  return { version: 2, name, devices: [{ role: "default" }], steps };
}

export interface ParityScenario {
  name: string;
  journey: Journey;
  /** Expected shared per-step outcome codes; `passed` for success. */
  expected: readonly string[];
}

export const scenarios: readonly ParityScenario[] = [
  {
    name: "search happy path",
    journey: journey("search", [openSearch, focusField, typeQuery, submitQuery]),
    expected: ["passed", "passed", "passed", "passed"]
  },
  {
    name: "back navigation",
    journey: journey("back", [
      openSearch,
      { action: "back", activity: { before: SEARCH, after: MAIN } }
    ]),
    expected: ["passed", "passed"]
  },
  {
    name: "missing locator",
    journey: journey("missing", [{
      action: "click",
      locator: { resourceId: "does_not_exist" },
      activity: { before: MAIN, after: MAIN }
    }]),
    expected: ["LOCATOR_NOT_FOUND"]
  },
  {
    name: "unknown resource id after navigation",
    journey: journey("unknown-after-navigation", [openSearch, {
      action: "click",
      locator: { text: "Submit" },
      activity: { before: SEARCH, after: SEARCH }
    }, {
      action: "click",
      locator: { resourceId: "search_root" },
      activity: { before: SEARCH, after: SEARCH }
    }]),
    expected: ["passed", "passed", "LOCATOR_NOT_FOUND"]
  },
  {
    name: "element expectation never appears",
    journey: journey("expect-missing", [{
      ...openSearch,
      expect: {
        type: "element",
        locator: { resourceId: "never_rendered" },
        timeoutMs: 200
      }
    }]),
    expected: ["EXPECT_ELEMENT_FAILED"]
  }
];
