/**
 * js-yaml the way electron-updater and electron-builder use it.
 *
 * Both depend on js-yaml 4, which reads and writes YAML 1.1 (timestamps become
 * Dates, `yes` is a boolean). js-yaml 5 defaults to YAML 1.2's core schema and
 * has no default export, so the feeds are read and written here with its
 * YAML 1.1 schema: the result matches what installed Electron apps see.
 */
import { dump as dumpYaml, load as loadYaml, YAML11_SCHEMA } from "js-yaml";

/** @param {string} text */
export const load = (text) => loadYaml(text, { schema: YAML11_SCHEMA });

/**
 * @param {unknown} value
 * @param {object} [options]
 */
export const dump = (value, options) => dumpYaml(value, { ...options, schema: YAML11_SCHEMA });

export default { load, dump };
