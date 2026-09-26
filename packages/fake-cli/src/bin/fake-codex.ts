#!/usr/bin/env node
import { main } from "../main.js";

process.exitCode = await main("codex", process.argv.slice(2));
