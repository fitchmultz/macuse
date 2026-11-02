#!/usr/bin/env node
import { checkPolicyConfig } from "./engineering-policy-config.mjs";
import { checkCoverage, projectFiles } from "./engineering-policy-coverage.mjs";
import { checkDirectives } from "./engineering-policy-directives.mjs";

const files = projectFiles();
checkPolicyConfig();
checkCoverage(files);
checkDirectives(files);
console.log("Engineering policy, project coverage, and directive inventory verified.");
