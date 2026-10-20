#!/usr/bin/env bun
/**
 * Print resolved runtime artifact paths for the current environment.
 * Useful for debugging where mcode stores its state.
 */
import * as NodePath from "node:path";
import { getRuntimePaths } from "./agent/runtime-contract.mjs";
import { scriptRoot } from "./utils.mjs";

const paths = getRuntimePaths(scriptRoot);
const dataDir = process.env.MCODE_DATA_DIR ?? paths.devDir;
const dbPath = process.env.MCODE_DB_PATH ?? paths.dbPath;
const logDir = NodePath.join(dataDir, "logs");

console.log(`Data dir : ${dataDir}`);
console.log(`Database : ${dbPath}`);
console.log(`Logs     : ${logDir}`);
