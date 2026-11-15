/**
 * This package's test surface: `bun:test` wrapped by `@ghostry/harness`, which
 * every test file imports instead of `bun:test` itself.
 *
 * No integrations yet. Each test builds the grammar it asserts on.
 *
 * @module
 */

import { initialize, type Attest } from "@ghostry/harness";
import * as framework from "bun:test";

const harness = initialize({ framework });

export const { describe, expect, test } = harness;

/**
 * Annotated, because an assertion narrows only through a binding whose type is
 * written out; a destructure never qualifies (TS2775).
 */
export const attest: Attest = harness.attest;
