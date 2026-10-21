#!/usr/bin/env node
import { main } from "../src/cli.mjs";

main(process.argv.slice(2)).then(code => {
  if (code !== null) process.exit(code);
}).catch(error => {
  console.error(error);
  process.exit(1);
});
