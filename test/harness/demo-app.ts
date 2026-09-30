import type { LayoutElement } from "../../src/domain/layout.js";
import type { Journey, JourneyStep } from "../../src/domain/journey.js";
import type { ExternalStep } from "../../src/domain/external-flow.js";
import type { RecordMove } from "./scripted-recorder-prompt.js";
import type { SimulatedApp } from "./simulated-device.js";

/**
 * A state-machine model of `examples/taphound-android-demo`: Main opens
 * Search; tapping the field focuses it, typing fills it, and submitting
 * publishes an accessibility result and a SearchViewModel log.
 */

export const DEMO_PACKAGE = "dev.taphound.demo";
export const MAIN = `${DEMO_PACKAGE}.MainActivity`;
export const SEARCH = `${DEMO_PACKAGE}.SearchActivity`;
export const MAIL_DETAIL = `${DEMO_PACKAGE}.MailDetailActivity`;
export const IMAGE_PREVIEW = `${DEMO_PACKAGE}.ImagePreviewActivity`;
export const CAMERA_PACKAGE = "com.android.camera";
export const CAMERA = `${CAMERA_PACKAGE}.CameraActivity`;
export const CAMERA_FLOW = "camera/photo-capture";

/**
 * The project External Flow the parity harness installs. Its first step
 * asserts that the video banner is gone (`absent`) after switching to photo
 * mode, then presses the shutter, which returns to the app under test.
 */
export const cameraFlowSteps: ExternalStep[] = [
  {
    action: "click",
    locator: { resourceId: "mode_photo" },
    expectedActivity: CAMERA,
    expect: {
      type: "element",
      locator: { resourceId: "video_banner" },
      absent: true,
      timeoutMs: 500
    }
  },
  {
    action: "click",
    locator: { resourceId: "shutter_button" },
    expectedActivity: CAMERA
  }
];

export const cameraFlow = {
  version: 1,
  kind: "externalFlow",
  name: CAMERA_FLOW,
  description: "Take one photo with the system camera",
  escapedPackageName: CAMERA_PACKAGE,
  expectedEscapeActivity: CAMERA,
  includes: [],
  steps: cameraFlowSteps
};

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

/**
 * A clickable Settings row whose label sits on the left and whose center is
 * covered by a favorite toggle: tapping the label opens Settings, tapping the
 * row center toggles the favorite.
 */
const settingsRow: LayoutElement = {
  id: "settings_row",
  resourceId: "settings_row",
  enabled: true,
  clickable: true,
  bounds: { left: 0, top: 1000, right: 1080, bottom: 1200 },
  children: [
    {
      id: "settings_label",
      text: "Settings",
      enabled: true,
      bounds: { left: 40, top: 1050, right: 340, bottom: 1150 },
      children: []
    },
    {
      id: "favorite_toggle",
      resourceId: "favorite_toggle",
      contentDescription: "Favorite",
      enabled: true,
      clickable: true,
      bounds: { left: 440, top: 1050, right: 640, bottom: 1150 },
      children: []
    }
  ]
};

/**
 * An inbox row handled by a RecyclerView item-touch listener: neither the
 * row nor any ancestor reports `clickable`, yet a touch on it opens the mail.
 */
const inboxList: LayoutElement = {
  id: "mail_list",
  resourceId: "mail_list",
  enabled: true,
  scrollable: true,
  bounds: { left: 0, top: 200, right: 1080, bottom: 1900 },
  children: [{
    id: "mail_row_1",
    resourceId: "mail_row",
    enabled: true,
    bounds: { left: 0, top: 200, right: 1080, bottom: 400 },
    children: [{
      id: "mail_subject",
      text: "Hello",
      enabled: true,
      bounds: { left: 40, top: 240, right: 640, bottom: 360 },
      children: []
    }]
  }]
};

/**
 * A mail body rendered in a WebView: the inline image is a DOM accessibility
 * node that reports no `clickable` and whose bounds overflow the WebView and
 * the display, so only its visible part inside the WebView can be touched.
 */
const mailBody: LayoutElement = {
  id: "mail_webview",
  resourceId: "mail_webview",
  enabled: true,
  scrollable: true,
  bounds: { left: 0, top: 300, right: 1080, bottom: 1900 },
  children: [{
    id: "body_image",
    text: "thumbnail?resId=0",
    enabled: true,
    bounds: { left: 60, top: 641, right: 1020, bottom: 2400 },
    children: []
  }]
};

export const demoApp: SimulatedApp = {
  packageName: DEMO_PACKAGE,
  launchActivity: MAIN,
  startScreen: "main",
  screens: {
    main: {
      activity: MAIN,
      layout: root("main_root", [
        button("open_search", "open_search", "Search", 300),
        button("take_photo", "take_photo", "Photo", 500),
        settingsRow,
        button("open_inbox", "open_inbox", "Inbox", 1300)
      ])
    },
    inbox: {
      activity: MAIN,
      layout: root("inbox_root", [inboxList])
    },
    mailDetail: {
      activity: MAIL_DETAIL,
      layout: root("mail_root", [{
        id: "mail_detail_title",
        resourceId: "mail_detail_title",
        text: "Hello",
        enabled: true,
        bounds: { left: 100, top: 100, right: 980, bottom: 200 },
        children: []
      }, mailBody])
    },
    imagePreview: {
      activity: IMAGE_PREVIEW,
      layout: root("preview_root", [{
        id: "preview_image",
        resourceId: "preview_image",
        enabled: true,
        bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
        children: []
      }])
    },
    settings: {
      activity: MAIN,
      layout: root("settings_root", [{
        id: "settings_title",
        resourceId: "settings_title",
        text: "Settings",
        enabled: true,
        bounds: { left: 100, top: 100, right: 980, bottom: 200 },
        children: []
      }])
    },
    favorited: {
      activity: MAIN,
      layout: root("main_root", [{
        id: "favorite_on",
        resourceId: "favorite_on",
        enabled: true,
        bounds: { left: 100, top: 100, right: 980, bottom: 200 },
        children: []
      }])
    },
    photoAttached: {
      activity: MAIN,
      layout: root("main_root", [
        button("open_search", "open_search", "Search", 300),
        button("take_photo", "take_photo", "Photo", 500),
        {
          id: "photo_preview",
          resourceId: "photo_preview",
          contentDescription: "photo attached",
          enabled: true,
          bounds: { left: 100, top: 700, right: 980, bottom: 900 },
          children: []
        }
      ])
    },
    cameraVideo: {
      packageName: CAMERA_PACKAGE,
      activity: CAMERA,
      layout: root("camera_root", [
        button("mode_photo", "mode_photo", "Photo", 100),
        {
          id: "video_banner",
          resourceId: "video_banner",
          text: "Video mode",
          enabled: true,
          bounds: { left: 100, top: 300, right: 980, bottom: 360 },
          children: []
        },
        button("shutter_button", "shutter_button", "Shutter", 1600)
      ])
    },
    cameraPhoto: {
      packageName: CAMERA_PACKAGE,
      activity: CAMERA,
      layout: root("camera_root", [
        button("mode_photo", "mode_photo", "Photo", 100),
        button("shutter_button", "shutter_button", "Shutter", 1600)
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
    { from: "main", on: { action: "tap", elementId: "take_photo" }, to: "cameraVideo" },
    { from: "main", on: { action: "tap", elementId: "favorite_toggle" }, to: "favorited" },
    { from: "main", on: { action: "tap", elementId: "settings_row" }, to: "settings" },
    { from: "cameraVideo", on: { action: "tap", elementId: "mode_photo" }, to: "cameraPhoto" },
    { from: "cameraPhoto", on: { action: "tap", elementId: "shutter_button" }, to: "photoAttached" },
    { from: "searchFocused", on: { action: "back" }, to: "main" },
    { from: "main", on: { action: "tap", elementId: "open_inbox" }, to: "inbox" },
    { from: "inbox", on: { action: "tap", elementId: "mail_row_1" }, to: "mailDetail" },
    { from: "mailDetail", on: { action: "tap", elementId: "body_image" }, to: "imagePreview" }
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
  /**
   * Recorded-policy Replay outcomes where they intentionally differ: it
   * does not check action capabilities, because the Recorder only offers
   * targets that already have them.
   */
  recordedReplay?: readonly string[];
  /**
   * Generation outcomes where the code intentionally differs: it rejects a
   * target without the action capability before mutating the device, with
   * `ACTION_UNSUPPORTED`.
   */
  generation?: readonly string[];
  /**
   * How a person records this Journey with `taphound record`. The recorded
   * Journey must match `journey` (the Recorder adds no expectations) and
   * replay with every step passing.
   */
  record?: readonly RecordMove[];
}

const openSettings: JourneyStep = {
  action: "click",
  locator: { text: "Settings" },
  activity: { before: MAIN, after: MAIN },
  expect: {
    type: "element",
    locator: { resourceId: "settings_title" },
    timeoutMs: 200
  }
};

const takePhoto: JourneyStep = {
  action: "bridge",
  scenario: "photoCapture",
  description: "Attach a photo from the system camera",
  triggerLocator: { resourceId: "take_photo" },
  escapedPackageName: CAMERA_PACKAGE,
  returnTimeoutMs: 2000,
  externalSteps: cameraFlowSteps,
  replayMode: "auto",
  activity: { before: MAIN, after: MAIN },
  expect: {
    type: "element",
    locator: { contentDescription: "photo attached" },
    timeoutMs: 500
  }
};

const openInbox: JourneyStep = {
  action: "click",
  locator: { resourceId: "open_inbox" },
  activity: { before: MAIN, after: MAIN },
  expect: {
    type: "element",
    locator: { resourceId: "mail_list" },
    timeoutMs: 200
  }
};

const openMail: JourneyStep = {
  action: "click",
  locator: { text: "Hello" },
  touchPolicy: "element",
  activity: { before: MAIN, after: MAIL_DETAIL },
  expect: {
    type: "element",
    locator: { resourceId: "mail_detail_title" },
    timeoutMs: 200
  }
};

const openBodyImage: JourneyStep = {
  action: "click",
  locator: { text: "thumbnail?resId=0" },
  touchPolicy: "element",
  activity: { before: MAIL_DETAIL, after: IMAGE_PREVIEW },
  expect: {
    type: "element",
    locator: { resourceId: "preview_image" },
    timeoutMs: 200
  }
};

export const scenarios: readonly ParityScenario[] = [
  {
    name: "camera bridge through an External Flow",
    journey: journey("camera", [takePhoto]),
    expected: ["passed"],
    record: [{
      action: "bridgeTrigger",
      scenario: "photoCapture",
      description: "Attach a photo from the system camera",
      returnTimeoutMs: 2000,
      target: "take_photo",
      external: [
        { action: "click", target: "mode_photo" },
        // The shutter returns to the app, which ends the external steps.
        { action: "click", target: "shutter_button" }
      ]
    }]
  },
  {
    name: "search happy path",
    journey: journey("search", [openSearch, focusField, typeQuery, submitQuery]),
    expected: ["passed", "passed", "passed", "passed"],
    record: [
      { action: "click", target: "open_search" },
      { action: "click", target: "search_input" },
      { action: "inputText", text: "hello world" },
      { action: "click", target: "submit_search" }
    ]
  },
  {
    name: "back navigation",
    journey: journey("back", [
      openSearch,
      { action: "back", activity: { before: SEARCH, after: MAIN } }
    ]),
    expected: ["passed", "passed"],
    record: [
      { action: "click", target: "open_search" },
      { action: "back" }
    ]
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
    name: "label inside a clickable row",
    journey: journey("settings-label", [openSettings]),
    expected: ["passed"]
  },
  {
    name: "click on an element no clickable ancestor handles",
    journey: journey("dead-click", [openSettings, {
      action: "click",
      locator: { resourceId: "settings_title" },
      activity: { before: MAIN, after: MAIN }
    }]),
    expected: ["passed", "ACTION_FAILED"],
    recordedReplay: ["passed", "passed"],
    generation: ["passed", "ACTION_UNSUPPORTED"]
  },
  {
    name: "touchPolicy element opens a row no clickable ancestor reports",
    journey: journey("inbox-row", [openInbox, openMail]),
    expected: ["passed", "passed"]
  },
  {
    name: "touchPolicy element taps the visible part of a WebView image",
    journey: journey("webview-image", [openInbox, openMail, openBodyImage]),
    expected: ["passed", "passed", "passed"]
  },
  {
    name: "row without touchPolicy stays fail-closed",
    journey: journey("inbox-row-default", [openInbox, {
      action: "click",
      locator: { text: "Hello" },
      activity: { before: MAIN, after: MAIL_DETAIL }
    }]),
    expected: ["passed", "ACTION_FAILED"],
    recordedReplay: ["passed", "passed"],
    generation: ["passed", "ACTION_UNSUPPORTED"]
  },
  {
    name: "touchPolicy element on a target nothing handles",
    journey: journey("webview-dead-touch", [openInbox, openMail, {
      ...openBodyImage,
      locator: { resourceId: "mail_detail_title" },
      activity: { before: MAIL_DETAIL, after: MAIL_DETAIL }
    }]),
    expected: ["passed", "passed", "EXPECT_ELEMENT_FAILED"]
  },
  {
    name: "touchPolicy element whose expectation already holds",
    journey: journey("webview-vacuous-expect", [openInbox, openMail, {
      ...openBodyImage,
      activity: { before: MAIL_DETAIL, after: IMAGE_PREVIEW },
      expect: {
        type: "element",
        locator: { resourceId: "mail_detail_title" },
        timeoutMs: 200
      }
    }]),
    expected: ["passed", "passed", "ACTION_FAILED"],
    generation: ["passed", "passed", "EXPECT_UNSUPPORTED"]
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
