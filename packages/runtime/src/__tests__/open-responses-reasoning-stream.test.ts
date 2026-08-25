/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenResponsesReasoningStreamNormalizer } from '../open-responses-reasoning-stream.js';

function added(id: string) {
  return {
    type: 'response.output_item.added',
    item: { type: 'reasoning', id, summary: [] },
  };
}

function summaryDelta(id: string, summaryIndex: number, delta: string) {
  return {
    type: 'response.reasoning_summary_text.delta',
    item_id: id,
    summary_index: summaryIndex,
    delta,
  };
}

function summaryDone(id: string, summaryIndex: number, text: string) {
  return {
    type: 'response.reasoning_summary_text.done',
    item_id: id,
    summary_index: summaryIndex,
    text,
  };
}

function contentDelta(id: string, delta: string) {
  return {
    type: 'response.reasoning_text.delta',
    item_id: id,
    content_index: 0,
    delta,
  };
}

function contentDone(id: string, text: string) {
  return {
    type: 'response.reasoning_text.done',
    item_id: id,
    content_index: 0,
    text,
  };
}

function outputDone(id: string, parts: string[]) {
  return {
    type: 'response.output_item.done',
    item: {
      type: 'reasoning',
      id,
      summary: parts.map((text) => ({ type: 'summary_text', text })),
    },
  };
}

function texts(result: { events: readonly { kind: string; text?: string }[] }): string[] {
  return result.events.flatMap((event) =>
    event.kind === 'thinking' && typeof event.text === 'string' ? [event.text] : [],
  );
}

test('normalizes official summary parts and validates every done boundary', () => {
  const stream = new OpenResponsesReasoningStreamNormalizer();
  stream.consume(added('r1'));
  assert.deepEqual(texts(stream.consume(summaryDelta('r1', 0, 'first'))), ['first']);
  assert.deepEqual(texts(stream.consume(summaryDone('r1', 0, 'first'))), []);
  assert.deepEqual(texts(stream.consume(summaryDelta('r1', 1, ' second'))), [' second']);
  assert.deepEqual(texts(stream.consume(summaryDone('r1', 1, ' second'))), []);
  assert.deepEqual(texts(stream.consume(outputDone('r1', ['first', ' second']))), []);
  assert.equal(stream.hasUnfinalizedItems(), false);
});

test('keeps the first carrier live and suppresses a duplicate migration carrier', () => {
  const stream = new OpenResponsesReasoningStreamNormalizer();
  stream.consume(added('r1'));
  assert.deepEqual(texts(stream.consume(contentDelta('r1', 'shared summary'))), ['shared summary']);
  assert.deepEqual(texts(stream.consume(summaryDelta('r1', 0, 'shared summary'))), []);
  assert.deepEqual(texts(stream.consume(outputDone('r1', ['shared summary']))), []);

  const reverse = new OpenResponsesReasoningStreamNormalizer();
  assert.deepEqual(texts(reverse.consume(summaryDelta('r2', 0, 'official first'))), [
    'official first',
  ]);
  assert.deepEqual(texts(reverse.consume(contentDelta('r2', 'official first'))), []);
  assert.deepEqual(texts(reverse.consume(outputDone('r2', ['official first']))), []);

  const divergent = new OpenResponsesReasoningStreamNormalizer();
  divergent.consume(summaryDelta('r3', 0, 'official'));
  divergent.consume(contentDelta('r3', 'different'));
  assert.throws(
    () => divergent.consume(outputDone('r3', ['official'])),
    /compatibility reasoning does not match final provider summary/,
  );
});

test('keeps the compatibility carrier token-live through final validation', () => {
  const stream = new OpenResponsesReasoningStreamNormalizer();
  stream.consume(added('r1'));
  assert.deepEqual(texts(stream.consume(contentDelta('r1', 'compatibility '))), ['compatibility ']);
  assert.deepEqual(texts(stream.consume(contentDelta('r1', 'summary'))), ['summary']);
  assert.deepEqual(texts(stream.consume(contentDone('r1', 'compatibility summary'))), []);
  assert.deepEqual(texts(stream.consume(outputDone('r1', ['compatibility summary']))), []);
});

test('uses done or final summary as canonical text when deltas are absent', () => {
  const doneOnly = new OpenResponsesReasoningStreamNormalizer();
  doneOnly.consume(added('done-only'));
  assert.deepEqual(texts(doneOnly.consume(summaryDone('done-only', 0, 'done summary'))), [
    'done summary',
  ]);
  assert.deepEqual(texts(doneOnly.consume(outputDone('done-only', ['done summary']))), []);

  const finalOnly = new OpenResponsesReasoningStreamNormalizer();
  finalOnly.consume(added('final-only'));
  assert.deepEqual(texts(finalOnly.consume(outputDone('final-only', ['final summary']))), [
    'final summary',
  ]);

  const emptyDone = new OpenResponsesReasoningStreamNormalizer();
  emptyDone.consume(summaryDone('empty-done', 0, ''));
  assert.throws(
    () => emptyDone.consume(outputDone('empty-done', ['non-empty'])),
    /reasoning part does not match final provider summary/,
  );

  const emptyCompatibilityDone = new OpenResponsesReasoningStreamNormalizer();
  emptyCompatibilityDone.consume(contentDone('empty-content-done', ''));
  assert.throws(
    () => emptyCompatibilityDone.consume(outputDone('empty-content-done', ['non-empty'])),
    /compatibility reasoning does not match final provider summary/,
  );

  const matchingEmptyDone = new OpenResponsesReasoningStreamNormalizer();
  matchingEmptyDone.consume(summaryDone('matching-empty', 0, ''));
  assert.deepEqual(texts(matchingEmptyDone.consume(outputDone('matching-empty', ['']))), []);
});

test('fails closed when delta, done, or final summary disagree', () => {
  const doneMismatch = new OpenResponsesReasoningStreamNormalizer();
  doneMismatch.consume(summaryDelta('r1', 0, 'delta'));
  assert.throws(
    () => doneMismatch.consume(summaryDone('r1', 0, 'different')),
    /does not match its done event/,
  );

  const finalMismatch = new OpenResponsesReasoningStreamNormalizer();
  finalMismatch.consume(summaryDelta('r2', 0, 'streamed'));
  assert.throws(
    () => finalMismatch.consume(outputDone('r2', ['different'])),
    /does not match final provider summary/,
  );

  const boundaryMismatch = new OpenResponsesReasoningStreamNormalizer();
  boundaryMismatch.consume(summaryDelta('r3', 0, 'ab'));
  boundaryMismatch.consume(summaryDelta('r3', 1, 'c'));
  assert.throws(
    () => boundaryMismatch.consume(outputDone('r3', ['a', 'bc'])),
    /reasoning part does not match final provider summary/,
  );
});

test('keeps multiple unfinished items visible but marks them all undurable', () => {
  const stream = new OpenResponsesReasoningStreamNormalizer();
  assert.deepEqual(texts(stream.consume(contentDelta('r1', 'first partial'))), ['first partial']);
  assert.deepEqual(texts(stream.consume(contentDelta('r2', 'second partial'))), ['second partial']);
  const terminal = stream.consume({ type: 'response.failed', response: { status: 'failed' } });
  assert.deepEqual(texts(terminal), []);
  assert.equal(terminal.unfinalizedTerminal, true);
  assert.equal(stream.hasUnfinalizedItems(), true);
});

test('rejects unsafe identities and out-of-range summary indexes', () => {
  const stream = new OpenResponsesReasoningStreamNormalizer();
  const unsafeId = 'x'.repeat(513);
  assert.deepEqual(texts(stream.consume(added(unsafeId))), []);
  const unsafeDelta = stream.consume(contentDelta(unsafeId, 'visible but undurable'));
  assert.deepEqual(texts(unsafeDelta), ['visible but undurable']);
  assert.equal(
    unsafeDelta.events[0]?.kind === 'thinking' && 'reasoningItemId' in unsafeDelta.events[0],
    false,
  );
  assert.throws(
    () => stream.consume(outputDone(unsafeId, ['visible but undurable'])),
    /invalid reasoning item id/,
  );
  assert.throws(
    () => stream.consume(summaryDelta('r1', 128, 'out of range')),
    /invalid summary index/,
  );
});

test('rejects a second finalized item with the same provider identity', () => {
  const stream = new OpenResponsesReasoningStreamNormalizer();
  stream.consume(summaryDelta('r1', 0, 'first'));
  stream.consume(outputDone('r1', ['first']));
  stream.consume(summaryDelta('r1', 0, 'second'));
  assert.throws(() => stream.consume(outputDone('r1', ['second'])), /finalized more than once/);
});

test('bounds reasoning text even when every provider item id is unsafe', () => {
  const stream = new OpenResponsesReasoningStreamNormalizer();
  const unsafeId = 'x'.repeat(513);
  stream.consume(contentDelta(unsafeId, 'x'.repeat(10_000_000)));
  assert.throws(
    () => stream.consume(contentDelta(unsafeId, 'x')),
    /Undurable Responses reasoning stream exceeds the text limit/,
  );
});

test('suppresses only SDK plaintext reasoning deltas', () => {
  const stream = new OpenResponsesReasoningStreamNormalizer();
  assert.equal(stream.suppressMappedChunk('reasoning-delta'), false);
  stream.consume(added('r1'));
  assert.equal(stream.suppressMappedChunk('reasoning'), true);
  assert.equal(stream.suppressMappedChunk('reasoning-delta'), true);
  assert.equal(stream.suppressMappedChunk('reasoning-start'), false);
  assert.equal(stream.suppressMappedChunk('reasoning-end'), false);
  assert.equal(stream.suppressMappedChunk('text-delta'), false);
});
