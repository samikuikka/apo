# SDK Tests

This directory contains unit tests for the apo SDK.

## Running Tests

From the `packages/sdk` directory:

```bash
# Run tests once
pnpm test

# Run tests in watch mode (auto-rerun on file changes)
pnpm test:watch

# Run tests with coverage report
pnpm test:coverage
```

## Test Structure

- **prompt.test.ts** - Comprehensive tests for the prompt template system
  - Basic functionality (string/JSON interpolation)
  - Data type handling (strings, numbers, booleans, objects, arrays)
  - Edge cases (unicode, special characters, long strings)
  - Error handling (validation, unknown placeholders)
  - Real-world scenarios
  - Type safety verification

## Coverage

Current test coverage for `prompt.ts`: **100%**

Coverage reports are generated in the `coverage/` directory when running `pnpm test:coverage`.

## Writing New Tests

Tests use [Vitest](https://vitest.dev/) as the testing framework. Example:

```typescript
import { describe, it, expect } from 'vitest';
import { definePrompt, renderPrompt } from '../src/prompt';
import { z } from 'zod';

describe('My Feature', () => {
  it('should do something', () => {
    const prompt = definePrompt({
      id: 'test',
      role: 'system',
      template: 'Hello {{name}}',
      schema: z.object({ name: z.string() }),
    });
    
    const result = renderPrompt(prompt, { name: 'World' });
    expect(result).toBe('Hello World');
  });
});
```
