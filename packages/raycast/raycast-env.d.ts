/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** API URL - Address of your Track Your Time server, for example https://api.example.com. Leave empty for the hosted server. */
  "apiUrl"?: string,
  /** Web App URL - Address of the matching web app, where you approve sign-in. Leave empty for the hosted web app. */
  "webUrl"?: string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `menu-bar` command */
  export type MenuBar = ExtensionPreferences & {
  /** Menu Bar Title - What the menu bar shows while a timer runs. */
  "titleMode": "duration" | "description" | "both" | "icon",
  /** When No Timer Runs - What the menu bar shows while no timer runs. */
  "idleTitle": "none" | "prompt" | "total",
  /** Clock - On keeps the command loaded so the clock moves every second. Off updates the clock once a minute. */
  "tickSeconds": boolean,
  /** Idle - The item comes back when a timer starts. */
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

