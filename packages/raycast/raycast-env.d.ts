/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** API URL - Origin of the Track Your Time server, e.g. https://api.example.com. Empty means the deployed server, or the local dev server under `ray develop`. */
  "apiUrl"?: string,
  /** Web App URL - Origin of the Track Your Time web app, used for the device-pairing page and Open in Browser. Empty follows the build: the deployed web app in a `ray build`, http://localhost:3392 under `ray develop`. */
  "webUrl"?: string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `menu-bar` command */
  export type MenuBar = ExtensionPreferences & {
  /** Menu Bar Title - What the menu bar shows while a timer runs. */
  "titleMode": "duration" | "description" | "both" | "icon",
  /** When Nothing Runs - What the menu bar shows while no timer is running. */
  "idleTitle": "none" | "prompt" | "total",
  /** Clock - Keeps the command loaded so the menu bar clock moves every second. Off shows minutes, refreshed on the command's interval. */
  "tickSeconds": boolean,
  /** Idle - Keeps the menu bar clean; the item reappears on the next start. */
  "hideWhenIdle": boolean
}
  /** Preferences accessible in the `toggle-timer` command */
  export type ToggleTimer = ExtensionPreferences & {}
  /** Preferences accessible in the `timer` command */
  export type Timer = ExtensionPreferences & {}
  /** Preferences accessible in the `entries` command */
  export type Entries = ExtensionPreferences & {}
  /** Preferences accessible in the `open-dashboard` command */
  export type OpenDashboard = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `menu-bar` command */
  export type MenuBar = {}
  /** Arguments passed to the `toggle-timer` command */
  export type ToggleTimer = {}
  /** Arguments passed to the `timer` command */
  export type Timer = {}
  /** Arguments passed to the `entries` command */
  export type Entries = {}
  /** Arguments passed to the `open-dashboard` command */
  export type OpenDashboard = {}
}

