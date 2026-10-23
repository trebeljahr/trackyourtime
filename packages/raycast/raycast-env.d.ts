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
  "webUrl"?: string,
  /** Error Report DSN - Optional Sentry-compatible DSN for diagnostic errors. Leave empty to send no reports. */
  "errorReportDsn"?: string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `menu-bar` command */
  export type MenuBar = ExtensionPreferences & {
  /** When Idle - Off shows only a running timer. Timers started elsewhere appear on the next background refresh (within a minute). */
  "showWhenIdle": boolean
}
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
  /** Arguments passed to the `timer` command */
  export type Timer = {}
  /** Arguments passed to the `entries` command */
  export type Entries = {}
  /** Arguments passed to the `open-dashboard` command */
  export type OpenDashboard = {}
}

