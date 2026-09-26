#!/usr/bin/env node
import { main } from "../main.js";

process.exitCode = await main("claude", process.argv.slice(2));
