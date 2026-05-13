/**
 * YAML schema validation for Monaco editor diagnostics.
 * Uses AJV to validate parsed YAML against the AgentWorks OS rule-pack schema.
 * Returns Monaco IMarker arrays for inline error/warning surfacing.
 */

import Ajv, { type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import * as YAML from 'yaml';
// eslint-disable-next-line
const rulePackSchema = require('../../../shared/src/schema/rule-pack-v1.0.json');

// Monaco marker severity values (MarkerSeverity enum)
const SEVERITY_ERROR = 8;
const SEVERITY_WARNING = 4;
const SEVERITY_INFO = 2;

// AJV instance — compile once, reuse
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(rulePackSchema);

/** Monaco IMarker-compatible marker */
export interface ValidationMarker {
  severity: number;
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** Result of a full validation pass */
export interface ValidationResult {
  markers: ValidationMarker[];
  valid: boolean;
  parseError: string | null;
}

/**
 * Map an AJV error to a line/col position in the original YAML source.
 */
function ajvErrorToMarker(
  error: ErrorObject,
  doc: unknown,
  yamlText: string,
  yamlDoc: YAML.Document,
): ValidationMarker {
  const parts = error.instancePath.replace(/^\//, '').split('/');
  const pathSnippets: string[] = [];

  // Build readable field path
  let cursor: unknown = doc;
  for (const part of parts) {
    if (part === '') continue;
    if (/^\d+$/.test(part)) {
      pathSnippets.push(`[${part}]`);
      cursor = (cursor as unknown[])[parseInt(part, 10)];
    } else {
      if (pathSnippets.length > 0) pathSnippets.push('.');
      pathSnippets.push(part);
      cursor = (cursor as Record<string, unknown>)[part];
    }
  }

  const fieldPath = pathSnippets.join('');
  let message = error.message ?? 'Invalid value';
  if (error.keyword === 'additionalProperties') {
    const prop = (error.params as { additionalProperty?: string })?.additionalProperty;
    if (prop) message = `unknown property '${prop}': ${message}`;
  } else if (error.keyword === 'required') {
    const prop = (error.params as { missingProperty?: string })?.missingProperty;
    if (prop) message = `missing required property '${prop}'`;
  }
  const isError = ['required', 'additionalProperties', 'type'].includes(error.keyword);

  let startLineNumber = 1;
  let startColumn = 1;
  let endLineNumber = 1;
  let endColumn = 80;

  // Try to get position from YAML AST node
  try {
    const filterParts = parts.filter(Boolean).map(p => (/^\d+$/.test(p) ? parseInt(p, 10) : p));
    const node = yamlDoc.getIn(filterParts);
    if (node && typeof node === 'object' && 'range' in (node as object)) {
      const range = (node as { range?: [number, number] }).range;
      if (range && range[0] > 0) {
        // range[0] > 0 ensures we have a meaningful position (not the root YAMLMap which starts at 0)
        const lines = yamlText.split('\n');
        let offset = 0;
        for (let i = 0; i < lines.length; i++) {
          const lineLen = lines[i].length + 1;
          if (offset + lineLen > range[0]) {
            startLineNumber = i + 1;
            startColumn = range[0] - offset + 1;
            endLineNumber = startLineNumber;
            endColumn = Math.min(startColumn + (fieldPath.length || 10), 200);
            break;
          }
          offset += lineLen;
        }
      }
    }
  } catch {
    // Fall through to text-based fallback
  }

  // Text-based fallback: scan lines for the offending property name
  if (startLineNumber === 1) {
    const lines = yamlText.split('\n');
    if (error.keyword === 'required') {
      const missingProp = error.params?.missingProperty as string | undefined;
      if (missingProp) {
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(missingProp)) {
            startLineNumber = i + 1;
            startColumn = lines[i].indexOf(missingProp) + 1;
            endLineNumber = i + 1;
            endColumn = startColumn + missingProp.length;
            break;
          }
        }
      }
    } else if (error.keyword === 'additionalProperties') {
      const prop = error.params?.additionalProperty as string | undefined;
      if (prop) {
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(prop)) {
            startLineNumber = i + 1;
            startColumn = lines[i].indexOf(prop) + 1;
            endLineNumber = i + 1;
            endColumn = startColumn + prop.length;
            break;
          }
        }
      }
    }
  }

  return {
    severity: isError ? SEVERITY_ERROR : SEVERITY_WARNING,
    message: fieldPath ? `${fieldPath}: ${message}` : message,
    startLineNumber,
    startColumn,
    endLineNumber,
    endColumn,
  };
}

/**
 * Validate YAML text against the rule-pack schema.
 *
 * Two-pass: parse YAML first (well-formedness), then AJV (schema compliance).
 * Returns Monaco-compatible markers that can be fed directly to setModelMarkers().
 */
export function validateYaml(yamlText: string): ValidationResult {
  if (!yamlText.trim()) {
    return { markers: [], valid: true, parseError: null };
  }

  // Step 1: YAML parse — catch syntax errors
  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlText, { strict: true, prettyErrors: false });
  } catch (e) {
    const err = e as YAML.YAMLParseError;
    const parseError = err.message;
    const lineAndCol = (err as { lineAndCol?: { line: number; col: number } }).lineAndCol;
    let startLineNumber = 1;
    let startColumn = 1;
    let endLineNumber = 1;
    let endColumn = 80;

    if (lineAndCol) {
      startLineNumber = lineAndCol.line;
      startColumn = lineAndCol.col;
      endLineNumber = lineAndCol.line;
      endColumn = Math.min(lineAndCol.col + 20, 200);
    }

    return {
      markers: [{
        severity: SEVERITY_ERROR,
        message: parseError,
        startLineNumber,
        startColumn,
        endLineNumber,
        endColumn,
      }],
      valid: false,
      parseError,
    };
  }

  // Step 2: AJV schema validation
  const valid = validate(parsed);
  if (valid) {
    return { markers: [], valid: true, parseError: null };
  }

  const yamlDoc = YAML.parseDocument(yamlText);
  const errors = validate.errors ?? [];
  const markers: ValidationMarker[] = errors.map(err =>
    ajvErrorToMarker(err, parsed, yamlText, yamlDoc)
  );

  return { markers, valid: false, parseError: null };
}
