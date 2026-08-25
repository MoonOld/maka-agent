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

import type { ModelStreamEvent } from './model-protocol.js';
import {
  PLAINTEXT_RESPONSES_MAX_SUMMARY_PARTS,
  PLAINTEXT_RESPONSES_MAX_SUMMARY_TEXT_LENGTH,
  safePlaintextResponsesReasoningItemId,
} from './responses-reasoning-state.js';

const MAX_REASONING_ITEMS = 128;

interface CarrierState {
  readonly textByIndex: Map<number, string>;
  readonly orderedDeltas: string[];
  totalLength: number;
}

interface ItemState {
  readonly summary: CarrierState;
  readonly content: CarrierState;
  selectedCarrier?: 'summary' | 'content';
}

export interface RawReasoningStreamResult {
  readonly events: readonly ModelStreamEvent[];
  readonly unfinalizedTerminal: boolean;
}

/**
 * Normalizes the two plaintext reasoning carriers published by Alibaba's
 * Responses endpoints. The international documentation uses the standard
 * `reasoning_summary_text` stream; the regional compatibility documentation
 * and current China endpoint use `reasoning_text`. Raw chunks are the only SDK
 * seam that preserves both before `@ai-sdk/open-responses` drops the standard
 * summary deltas.
 *
 * One normalizer belongs to one provider request. It never crosses the
 * ModelAdapter boundary and never creates durable provider metadata: the SDK's
 * `output_item.done` mapping remains the final item-id/summary authority.
 */
export class OpenResponsesReasoningStreamNormalizer {
  private readonly items = new Map<string, ItemState>();
  private readonly finalizedItemIds = new Set<string>();
  private sawRawReasoningEvent = false;
  private undurableTextLength = 0;

  consume(rawValue: unknown): RawReasoningStreamResult {
    const raw = record(rawValue);
    if (!raw) return emptyResult();
    const type = raw.type;
    if (typeof type !== 'string') return emptyResult();

    if (type === 'response.output_item.added') {
      const item = record(raw.item);
      if (item?.type === 'reasoning') {
        this.sawRawReasoningEvent = true;
        const itemId = safePlaintextResponsesReasoningItemId(item.id);
        if (itemId) this.ensureItem(itemId);
      }
      return emptyResult();
    }

    if (type === 'response.reasoning_summary_text.delta') {
      this.sawRawReasoningEvent = true;
      const delta = requireString(raw.delta, `${type}.delta`);
      const itemId = safePlaintextResponsesReasoningItemId(raw.item_id);
      if (!itemId) return this.acceptUndurableDelta(delta);
      const state = this.ensureItem(itemId);
      state.selectedCarrier ??= 'summary';
      appendCarrierDelta(state.summary, requireIndex(raw.summary_index, type), delta);
      return state.selectedCarrier === 'summary'
        ? eventResult(thinking(delta, itemId))
        : emptyResult();
    }

    if (type === 'response.reasoning_summary_text.done') {
      this.sawRawReasoningEvent = true;
      const itemId = safePlaintextResponsesReasoningItemId(raw.item_id);
      if (!itemId) return emptyResult();
      const state = this.ensureItem(itemId);
      state.selectedCarrier ??= 'summary';
      const text = requireString(raw.text, `${type}.text`);
      const index = requireIndex(raw.summary_index, type);
      return this.acceptDone(state, 'summary', itemId, index, text);
    }

    if (type === 'response.reasoning_text.delta') {
      this.sawRawReasoningEvent = true;
      const delta = requireString(raw.delta, `${type}.delta`);
      const itemId = safePlaintextResponsesReasoningItemId(raw.item_id);
      if (!itemId) return this.acceptUndurableDelta(delta);
      const state = this.ensureItem(itemId);
      state.selectedCarrier ??= 'content';
      appendCarrierDelta(state.content, requireOptionalIndex(raw.content_index, type), delta);
      return state.selectedCarrier === 'content'
        ? eventResult(thinking(delta, itemId))
        : emptyResult();
    }

    if (type === 'response.reasoning_text.done') {
      this.sawRawReasoningEvent = true;
      const itemId = safePlaintextResponsesReasoningItemId(raw.item_id);
      if (!itemId) return emptyResult();
      const state = this.ensureItem(itemId);
      state.selectedCarrier ??= 'content';
      return this.acceptDone(
        state,
        'content',
        itemId,
        requireOptionalIndex(raw.content_index, type),
        requireString(raw.text, `${type}.text`),
      );
    }

    if (type === 'response.output_item.done') {
      const item = record(raw.item);
      if (item?.type !== 'reasoning') return emptyResult();
      this.sawRawReasoningEvent = true;
      return {
        events: this.finalizeItem(requireItemId(item.id, type), item.summary),
        unfinalizedTerminal: false,
      };
    }

    if (
      type === 'response.completed' ||
      type === 'response.incomplete' ||
      type === 'response.failed' ||
      type === 'error'
    ) {
      return { events: [], unfinalizedTerminal: this.items.size > 0 };
    }

    return emptyResult();
  }

  /** SDK reasoning deltas duplicate the raw carriers consumed above. */
  suppressMappedChunk(type: string): boolean {
    return this.sawRawReasoningEvent && (type === 'reasoning' || type === 'reasoning-delta');
  }

  hasUnfinalizedItems(): boolean {
    return this.items.size > 0;
  }

  private ensureItem(itemId: string): ItemState {
    const existing = this.items.get(itemId);
    if (existing) return existing;
    if (this.items.size >= MAX_REASONING_ITEMS) {
      throw new Error('Responses reasoning stream exceeds the item limit');
    }
    const state: ItemState = {
      summary: carrierState(),
      content: carrierState(),
    };
    this.items.set(itemId, state);
    return state;
  }

  private acceptUndurableDelta(delta: string): RawReasoningStreamResult {
    this.undurableTextLength += delta.length;
    if (this.undurableTextLength > PLAINTEXT_RESPONSES_MAX_SUMMARY_TEXT_LENGTH) {
      throw new Error('Undurable Responses reasoning stream exceeds the text limit');
    }
    return eventResult(thinking(delta));
  }

  private acceptDone(
    state: ItemState,
    kind: 'summary' | 'content',
    itemId: string,
    index: number,
    text: string,
  ): RawReasoningStreamResult {
    const carrier = state[kind];
    const streamed = carrier.textByIndex.get(index);
    if (streamed !== undefined && streamed !== text) {
      throw new Error('Responses reasoning delta does not match its done event');
    }
    if (streamed !== undefined) return emptyResult();
    appendCarrierDelta(carrier, index, text);
    if (text.length === 0) return emptyResult();
    return state.selectedCarrier === kind ? eventResult(thinking(text, itemId)) : emptyResult();
  }

  private finalizeItem(itemId: string, rawSummary: unknown): readonly ModelStreamEvent[] {
    if (this.finalizedItemIds.has(itemId)) {
      throw new Error('Responses reasoning item was finalized more than once');
    }
    const state = this.ensureItem(itemId);
    const summaryParts = requireSummaryParts(rawSummary);
    const finalText = summaryParts.join('');
    const selected = state.selectedCarrier ? state[state.selectedCarrier] : undefined;
    const events: ModelStreamEvent[] = [];
    if (state.summary.textByIndex.size > 0) {
      for (const [index, text] of state.summary.textByIndex) {
        if (summaryParts[index] !== text) {
          throw new Error(
            'Streamed plaintext Responses reasoning part does not match final provider summary',
          );
        }
      }
      for (let index = 0; index < summaryParts.length; index += 1) {
        if (summaryParts[index]!.length > 0 && !state.summary.textByIndex.has(index)) {
          throw new Error('Responses reasoning summary stream is missing a final part');
        }
      }
    }
    if (state.content.textByIndex.size > 0 && state.content.orderedDeltas.join('') !== finalText) {
      throw new Error(
        'Streamed plaintext Responses compatibility reasoning does not match final provider summary',
      );
    }
    let streamedText = selected?.orderedDeltas.join('') ?? '';
    if (streamedText.length === 0 && finalText.length > 0 && !selected?.textByIndex.size) {
      events.push(thinking(finalText, itemId));
      streamedText = finalText;
    }
    if (streamedText !== finalText) {
      throw new Error(
        'Streamed plaintext Responses reasoning does not match final provider summary',
      );
    }
    if (this.finalizedItemIds.size >= MAX_REASONING_ITEMS) {
      throw new Error('Responses reasoning stream exceeds the finalized item limit');
    }
    this.finalizedItemIds.add(itemId);
    this.items.delete(itemId);
    return events;
  }
}

function carrierState(): CarrierState {
  return { textByIndex: new Map(), orderedDeltas: [], totalLength: 0 };
}

function appendCarrierDelta(carrier: CarrierState, index: number, delta: string): void {
  const totalLength = carrier.totalLength + delta.length;
  if (totalLength > PLAINTEXT_RESPONSES_MAX_SUMMARY_TEXT_LENGTH) {
    throw new Error('Responses reasoning stream exceeds the text limit');
  }
  carrier.totalLength = totalLength;
  carrier.textByIndex.set(index, (carrier.textByIndex.get(index) ?? '') + delta);
  carrier.orderedDeltas.push(delta);
}

function requireSummaryParts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > PLAINTEXT_RESPONSES_MAX_SUMMARY_PARTS) {
    throw new Error('Responses reasoning output item has an invalid summary');
  }
  let totalLength = 0;
  return value.map((rawPart) => {
    const part = record(rawPart);
    if (part?.type !== 'summary_text' || typeof part.text !== 'string') {
      throw new Error('Responses reasoning output item has an invalid summary');
    }
    totalLength += part.text.length;
    if (totalLength > PLAINTEXT_RESPONSES_MAX_SUMMARY_TEXT_LENGTH) {
      throw new Error('Responses reasoning output item exceeds the text limit');
    }
    return part.text;
  });
}

function requireItemId(value: unknown, eventType: string): string {
  const itemId = safePlaintextResponsesReasoningItemId(value);
  if (!itemId) throw new Error(`${eventType} has an invalid reasoning item id`);
  return itemId;
}

function requireIndex(value: unknown, eventType: string): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) >= PLAINTEXT_RESPONSES_MAX_SUMMARY_PARTS
  ) {
    throw new Error(`${eventType} has an invalid summary index`);
  }
  return Number(value);
}

function requireOptionalIndex(value: unknown, eventType: string): number {
  return value === undefined ? 0 : requireIndex(value, eventType);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function thinking(text: string, reasoningItemId?: string): ModelStreamEvent {
  return {
    kind: 'thinking',
    text,
    ...(reasoningItemId ? { reasoningItemId } : {}),
  };
}

function emptyResult(): RawReasoningStreamResult {
  return { events: [], unfinalizedTerminal: false };
}

function eventResult(event: ModelStreamEvent): RawReasoningStreamResult {
  return { events: [event], unfinalizedTerminal: false };
}
