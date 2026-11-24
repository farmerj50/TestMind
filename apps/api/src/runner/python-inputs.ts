import { redactWorkflowValue, validateValue } from '@testmind/core/workflow';

export interface PythonInputDeclaration {
  type: 'string' | 'number' | 'boolean' | 'json';
  required: boolean;
  secret?: false;
  /** Optional container-relative file containing this value; never a host path. */
  path?: string;
}
const reject = (): never => { throw new Error('PYTHON_INPUT_UNSAFE'); };
const plain = (value: any) => value && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === null || Object.getPrototypeOf(Object.getPrototypeOf(value)) === null);
const unsafeKey = (key: string) => ['__proto__', 'prototype', 'constructor'].includes(key);

/** Bound JSON before serialization; reject getters, coercions, cycles and non-JSON values. */
export function boundedPythonJson(value: unknown, limit = 65536): string {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (item: any, depth: number) => {
    if (++nodes > 2000 || depth > 16) reject();
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') { if (Buffer.byteLength(item) > limit) reject(); return; }
    if (typeof item === 'number') { if (!Number.isFinite(item)) reject(); return; }
    if (typeof item !== 'object' || (!Array.isArray(item) && !plain(item)) || seen.has(item)) reject();
    // JSON.stringify also looks up inherited toJSON; inspect descriptors without
    // invoking a getter or accepting a caller-controlled serialization hook.
    for (let prototype = Object.getPrototypeOf(item); prototype; prototype = Object.getPrototypeOf(prototype)) {
      if (Object.getOwnPropertyDescriptor(prototype, 'toJSON')) reject();
    }
    seen.add(item);
    const keys = Reflect.ownKeys(item);
    if (Array.isArray(item) && (item.length > 1000 || keys.length !== item.length + 1)) reject();
    for (const key of keys) {
      if (Array.isArray(item) && key === 'length') continue;
      if (typeof key !== 'string' || unsafeKey(key) || key.length > 128) reject();
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) reject();
      visit(descriptor.value, depth + 1);
    }
    seen.delete(item);
  };
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > limit) reject();
  return serialized;
}

export function safePythonValue(value: unknown, secretValues: string[], limit = 65536): string {
  const serialized = boundedPythonJson(value, limit);
  if (boundedPythonJson(redactWorkflowValue(JSON.parse(serialized), secretValues), limit) !== serialized) reject();
  return serialized;
}

export function preparePythonInputs(declarations: Record<string, PythonInputDeclaration>, values: Record<string, unknown>, secretValues: string[]) {
  if (!Array.isArray(secretValues) || secretValues.some(value => typeof value !== 'string')) reject();
  // Clone validated JSON, so subsequent caller mutation cannot add inputs during authorization.
  const declared = JSON.parse(boundedPythonJson(declarations, 16384));
  const inputs = JSON.parse(boundedPythonJson(values, 131072));
  if (!plain(declared) || !plain(inputs) || Object.keys(declared).length > 32
    || Object.keys(inputs).some(name => !Object.hasOwn(declared, name))) reject();
  const files: Record<string, string> = {};
  const paths = new Set<string>();
  for (const [name, raw] of Object.entries(declared)) {
    const spec = raw as PythonInputDeclaration;
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || unsafeKey(name) || !plain(spec)
      || Object.keys(spec).some(key => !['type', 'required', 'secret', 'path'].includes(key))
      || !['string', 'number', 'boolean', 'json'].includes(spec.type) || typeof spec.required !== 'boolean'
      || (spec.secret !== undefined && spec.secret !== false)) reject();
    if (spec.path !== undefined) {
      if (typeof spec.path !== 'string' || spec.path.length > 200
        || !/^inputs\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:txt|json)$/.test(spec.path)
        || paths.has(spec.path.toLowerCase()) || (spec.path.endsWith('.txt') && spec.type !== 'string')) reject();
      paths.add(spec.path.toLowerCase());
    }
    if (!Object.hasOwn(inputs, name)) { if (spec.required) reject(); continue; }
    if (!validateValue(spec.type, inputs[name])) reject();
    const serialized = safePythonValue({ [name]: inputs[name] }, secretValues);
    if (spec.path) files[spec.path] = spec.path.endsWith('.txt') ? inputs[name] as string : JSON.stringify(JSON.parse(serialized)[name]);
  }
  return { inputs, files };
}
