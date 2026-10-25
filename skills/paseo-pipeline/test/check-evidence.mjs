#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
let kind = 'smoke';
let filePath = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--kind') {
    kind = args[++i];
  } else if (!args[i].startsWith('--')) {
    filePath = args[i];
  }
}

if (!filePath) {
  console.error('Usage: node check-evidence.mjs [--kind smoke|audit] <file>');
  process.exit(1);
}

if (!fs.existsSync(filePath)) {
  console.error(`Error: File not found: ${filePath}`);
  process.exit(1);
}

const content = fs.readFileSync(filePath, 'utf8');

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/;

if (kind === 'audit') {
  const missing = [];
  if (!/(?:^|\n)\s*verdict:\s*\S+/i.test(content)) missing.push('verdict:');
  if (!/(?:^|\n)\s*reviewed_sha:\s*[0-9a-f]{7,40}/i.test(content)) missing.push('reviewed_sha:');

  if (missing.length > 0) {
    console.error(`[check-evidence] Audit evidence failed: missing ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log(`[check-evidence] Audit evidence valid: ${filePath}`);
  process.exit(0);
}

if (kind === 'smoke') {
  const missing = [];

  const parentMatch = content.match(/(?:^|\n)\s*parent_agent_id:\s*(\S+)/i);
  if (!parentMatch || !UUID_RE.test(parentMatch[1])) {
    missing.push('parent_agent_id (valid UUID required)');
  }

  const childMatch = content.match(/(?:^|\n)\s*child_agent_id:\s*(\S+)/i);
  if (!childMatch || !UUID_RE.test(childMatch[1])) {
    missing.push('child_agent_id (valid UUID required)');
  }

  const notifMsgMatch = content.match(/(?:^|\n)\s*notification_message_id:\s*(\S+)/i);
  if (!notifMsgMatch) {
    missing.push('notification_message_id');
  }

  const dispatchedMatch = content.match(/(?:^|\n)\s*dispatched_at:\s*(\S+)/i);
  if (!dispatchedMatch || !ISO_RE.test(dispatchedMatch[1])) {
    missing.push('dispatched_at (valid ISO timestamp required)');
  }

  const notifAtMatch = content.match(/(?:^|\n)\s*notification_at:\s*(\S+)/i);
  if (!notifAtMatch || !ISO_RE.test(notifAtMatch[1])) {
    missing.push('notification_at (valid ISO timestamp required)');
  }

  const resultMatch = content.match(/(?:^|\n)\s*result:\s*(PASS|FAIL)\b/i);
  if (!resultMatch) {
    missing.push('result (PASS|FAIL required)');
  }

  const relayMatch = content.match(/(?:^|\n)\s*relay_case:\s*(\S+)/i);
  if (!relayMatch) {
    missing.push('relay_case');
  }

  const unverifiedMatch = /(?:^|\n)\s*unverified:\s*/i.test(content);
  if (!unverifiedMatch) {
    missing.push('unverified: list');
  }

  if (missing.length > 0) {
    console.error(`[check-evidence] Smoke evidence failed: missing or invalid ${missing.join(', ')}`);
    process.exit(1);
  }

  console.log(`[check-evidence] Smoke evidence valid: ${filePath}`);
  process.exit(0);
}

console.error(`[check-evidence] Unknown kind: ${kind}`);
process.exit(1);
