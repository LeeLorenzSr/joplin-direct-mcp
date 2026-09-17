import type { JoplinItem } from './contracts.js';

/**
 * The plaintext sync-item format used by Joplin v3.7.18.  It consists of a
 * title, one empty line, an optional note body, one empty line, and property
 * lines.  This deliberately handles only plaintext items; encrypted payloads
 * have a different representation and must not be interpreted here.
 */

// BaseItem.syncItemDefinitions_ in v3.7.18 includes these seven wire item
// types. The service layer decides which ordinary domain types to expose;
// accepting master-key and revision records here lets an inventory be
// inspected and then safely gated without dropping data at the codec layer.
const SUPPORTED_TYPES = new Set([1, 2, 4, 5, 6, 9, 13]);
const METADATA_ONLY_TYPES = new Set([6, 9, 13]);
const ITEM_ID = /^[a-fA-F0-9]{32}$/;

function malformed(message: string): Error {
  return new Error(`Malformed Joplin sync item: ${message}`);
}

function assertType(type: unknown): asserts type is number {
  if (typeof type !== 'number' || !Number.isInteger(type) || !SUPPORTED_TYPES.has(type)) {
    throw malformed('unsupported type_');
  }
}

function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !ITEM_ID.test(id)) throw malformed('invalid id');
}

// BaseItem.serialize_format escapes existing literal backslash escapes first,
// then CR/LF.  Its inverse is intentionally kept in the same order as the
// upstream unserialize_format implementation.
function decodeProperty(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\\n/g, '\\n')
    .replace(/\\\r/g, '\\r');
}

function encodeProperty(value: string): string {
  return value
    .replace(/\\n/g, '\\\\n')
    .replace(/\\r/g, '\\\\r')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/** Parse a UTF-8 plaintext Joplin sync item without discarding unknown fields. */
export function parseItem(raw: string): JoplinItem {
  if (typeof raw !== 'string' || raw.length === 0) throw malformed('empty content');
  if (raw.includes('\0')) throw malformed('NUL byte');

  const lines = raw.split('\n') as string[];
  // The metadata separator is the final truly empty line.  Do not trim body
  // lines: whitespace-only lines are valid body content and must survive.
  let metadataSeparator = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] === '') {
      metadataSeparator = i;
      break;
    }
  }
  const metadataOnly = metadataSeparator < 0;
  if (!metadataOnly && (metadataSeparator < 1 || lines[1] !== '' || metadataSeparator === lines.length - 1)) {
    throw malformed('expected title/body and metadata sections');
  }

  const title = metadataOnly ? '' : lines[0];
  if (title === undefined) throw malformed('missing title');
  if (title.includes('\r')) throw malformed('title contains carriage return');
  const properties: Record<string, string> = {};
  for (let i = metadataOnly ? 0 : metadataSeparator + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) throw malformed('missing property line');
    if (line === '' || line.includes('\r')) throw malformed('invalid property line');
    const colon = line.indexOf(':');
    if (colon <= 0) throw malformed('property line has no key');
    const key = line.slice(0, colon).trim();
    if (!key || key === '__proto__' || key === 'prototype' || key === 'title' || key === 'body' || Object.prototype.hasOwnProperty.call(properties, key)) {
      throw malformed('invalid or duplicate property key');
    }
    properties[key] = decodeProperty(line.slice(colon + 1).trim());
  }

  const id = properties.id;
  const rawType = properties.type_;
  if (id === undefined || rawType === undefined) throw malformed('missing id or type_');
  assertId(id);
  if (!/^[1-9]\d*$/.test(rawType)) throw malformed('invalid type_');
  const type_ = Number(rawType);
  assertType(type_);
  if (metadataOnly && !METADATA_ONLY_TYPES.has(type_)) throw malformed('expected title/body and metadata sections');
  if (!metadataOnly && METADATA_ONLY_TYPES.has(type_) && (title !== '' || lines.slice(2, metadataSeparator).join('\n') !== '')) {
    throw malformed('metadata-only item has title or body');
  }
  delete properties.id;
  delete properties.type_;

  const body = metadataOnly ? '' : lines.slice(2, metadataSeparator).join('\n');
  // Joplin only assigns a body to notes. A non-note with bytes in this region
  // would otherwise be silently rewritten, so reject it as unsupported.
  if (type_ !== 1 && body !== '') throw malformed('body on non-note item');
  return { id, type_, title, body: type_ === 1 ? body : '', properties };
}

/** Serialize a plaintext Joplin sync item in the canonical v3.7.18 layout. */
export function serializeItem(item: JoplinItem): string {
  if (!item || typeof item !== 'object') throw malformed('item is not an object');
  assertId(item.id);
  assertType(item.type_);
  if (typeof item.title !== 'string' || typeof item.body !== 'string') throw malformed('title/body must be strings');
  if (item.title.includes('\n') || item.title.includes('\r')) throw malformed('title contains a newline');
  if (item.type_ !== 1 && item.body !== '') throw malformed('body on non-note item');
  if (METADATA_ONLY_TYPES.has(item.type_) && item.title !== '') throw malformed('metadata-only item has a title');
  if (!item.properties || typeof item.properties !== 'object' || Array.isArray(item.properties)) {
    throw malformed('properties must be a string dictionary');
  }

  const metadata = [`id: ${encodeProperty(item.id)}`];
  for (const [key, value] of Object.entries(item.properties)) {
    if (!key || key === '__proto__' || key === 'prototype' || key === 'id' || key === 'type_' || key === 'title' || key === 'body' || key.includes('\n') || key.includes('\r') || key.includes(':')) {
      throw malformed('invalid property key');
    }
    if (typeof value !== 'string') throw malformed('property values must be strings');
    metadata.push(`${key}: ${encodeProperty(value)}`);
  }
  metadata.push(`type_: ${item.type_}`);

  // BaseItem.serialize omits an empty body section. For a non-empty body the
  // two separators are the only newlines introduced around it, and there is
  // no trailing newline.
  if (METADATA_ONLY_TYPES.has(item.type_)) return metadata.join('\n');
  const bodySection = item.type_ === 1 && item.body !== '' ? `${item.body}\n\n` : '';
  return `${item.title}\n\n${bodySection}${metadata.join('\n')}`;
}
