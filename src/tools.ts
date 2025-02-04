import { z } from 'zod';
import type {
  JSONSchema7,
  JSONSchema7Definition,
  JSONSchema7TypeName,
} from 'json-schema';
import * as fs from 'fs';
import * as path from 'path';

// Define server tool type with proper schema types
export interface ServerTool {
  name: string;
  description?: string;
  inputSchema?: JSONSchema7;
  outputSchema?: JSONSchema7;
}

// Add logging utility
export interface LogOptions {
  debug?: boolean;
  type?: 'info' | 'error' | 'debug';
  skipFile?: boolean;
  skipConsole?: boolean;
}

export function log(
  message: string,
  data?: unknown,
  options: LogOptions = {}
): void {
  // Check DEBUG environment variable and debug namespace
  const debugEnabled =
    process.env.DEBUG &&
    (process.env.DEBUG === '*' ||
      process.env.DEBUG.split(',').some(
        ns => ns === 'mcp' || ns === 'mcp:*' || ns === '*'
      ));

  // Early return if debug is not enabled and not an error
  if (!debugEnabled && !options.debug && options.type !== 'error') {
    return;
  }

  const timestamp = new Date().toISOString();
  const logType = options.type || 'info';
  const logMessage = `[${timestamp}] [${logType}] ${message}${
    data ? '\n' + JSON.stringify(data, null, 2) : ''
  }`;

  // Write to file ONLY if DEBUG is enabled or if it's an error
  if (!options.skipFile && (debugEnabled || options.type === 'error')) {
    const logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    fs.appendFileSync(path.join(logDir, 'mcp-tools.log'), logMessage + '\n');
  }

  // Console log ONLY if DEBUG is enabled or if it's an error
  if (!options.skipConsole && (debugEnabled || options.type === 'error')) {
    if (options.type === 'error') {
      console.error(logMessage);
    } else if (options.type === 'debug') {
      console.debug(logMessage);
    } else {
      console.log(logMessage);
    }
  }
}

// Helper function to create a default schema that accepts any valid JSON
export function createDefaultSchema(): z.ZodTypeAny {
  return z.any();
}

// Helper function to convert JSON Schema to Zod schema
export function jsonSchemaToZod(
  schema: JSONSchema7Definition | undefined,
  debug = false
): z.ZodTypeAny {
  if (!schema || typeof schema === 'boolean') {
    return createDefaultSchema();
  }

  // Only log if debug is explicitly true and it's a top-level schema
  if (debug && schema.title) {
    log('Converting schema', schema, { debug, type: 'debug' });
  }

  try {
    // Handle oneOf/anyOf schemas by converting them to a proper type
    if (schema.oneOf || schema.anyOf) {
      const subSchemas = (schema.oneOf || schema.anyOf || [])
        .map(s => {
          if (typeof s === 'boolean') return undefined;
          return jsonSchemaToZod(s, debug);
        })
        .filter((s): s is z.ZodType => s !== undefined);

      if (subSchemas.length === 0) {
        // If no valid subschemas, create a type based on the parent schema type
        if (schema.type) {
          return createSchemaForType(schema as JSONSchema7, debug);
        }
        return createDefaultSchema();
      }
      if (subSchemas.length === 1) return subSchemas[0];

      // Create a proper union type with all schemas
      return z.union(
        subSchemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]
      );
    }

    return createSchemaForType(schema as JSONSchema7, debug);
  } catch (error) {
    // Only log error if debug is true
    if (debug) {
      log('Error converting schema', { error, schema }, { type: 'error' });
    }
    return createDefaultSchema();
  }
}

// Helper function to create schema based on type
function createSchemaForType(schema: JSONSchema7, debug = false): z.ZodTypeAny {
  const schemaType = schema.type as JSONSchema7TypeName | undefined;

  // Only log debug info if debug is true and it's a non-standard type
  if (
    debug &&
    (!schemaType ||
      !['string', 'number', 'boolean', 'object', 'array'].includes(schemaType))
  ) {
    log(`Using default schema for type: ${schemaType}`, schema, {
      debug,
      type: 'debug',
    });
  }

  switch (schemaType) {
    case 'string': {
      if (schema.enum && Array.isArray(schema.enum) && schema.enum.length > 0) {
        return z.enum(schema.enum as [string, ...string[]]);
      }
      return z.string();
    }

    case 'number':
    case 'integer': {
      return z.number();
    }

    case 'boolean': {
      return z.boolean();
    }

    case 'object': {
      if (!schema.properties) {
        return z.record(z.any());
      }

      const shape: Record<string, z.ZodType> = {};
      const required = new Set(schema.required || []);

      for (const [key, value] of Object.entries(schema.properties)) {
        try {
          // Special handling for webhook property
          if (key === 'webhook') {
            // Instead of using union, use object type with optional headers
            shape[key] = z.object({
              url: z.string(),
              headers: z.record(z.string()).optional(),
            });
            continue;
          }

          const propertySchema = jsonSchemaToZod(value, debug);
          shape[key] = required.has(key)
            ? propertySchema
            : propertySchema.optional();
        } catch (error) {
          log(`Error converting property ${key}`, error, {
            type: 'error',
            debug,
          });
          shape[key] = z.any();
        }
      }

      return z.object(shape).passthrough();
    }

    case 'array': {
      const itemSchema = schema.items
        ? Array.isArray(schema.items)
          ? z.union(
              schema.items.map(item => jsonSchemaToZod(item, debug)) as [
                z.ZodTypeAny,
                z.ZodTypeAny,
                ...z.ZodTypeAny[],
              ]
            )
          : jsonSchemaToZod(schema.items, debug)
        : z.any();

      return z.array(itemSchema);
    }

    case 'null': {
      return z.null();
    }

    default: {
      log(`Using default schema for type: ${schemaType}`, schema, {
        debug,
        type: 'debug',
      });
      return z.any();
    }
  }
}
