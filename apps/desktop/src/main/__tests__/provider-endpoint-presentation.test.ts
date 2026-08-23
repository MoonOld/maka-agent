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
import test from 'node:test';
import { PROVIDER_DEFAULTS } from '@maka/core/llm-connections';
import { providerEndpointPresentation } from '../../renderer/settings/provider-endpoint-presentation.js';

test('fixed Alibaba access paths expose their distinct effective endpoints read-only', () => {
  const api = providerEndpointPresentation({ providerType: 'alibaba' });
  const tokenPlanChina = providerEndpointPresentation({ providerType: 'alibaba-token-plan-cn' });

  assert.deepEqual(api, {
    value: PROVIDER_DEFAULTS.alibaba.baseUrl,
    editable: false,
    emptyState: 'missing',
  });
  assert.deepEqual(tokenPlanChina, {
    value: PROVIDER_DEFAULTS['alibaba-token-plan-cn'].baseUrl,
    editable: false,
    emptyState: 'missing',
  });
  assert.match(api.value!, /^https:\/\//);
  assert.match(tokenPlanChina.value!, /^https:\/\//);
  assert.notEqual(api.value, tokenPlanChina.value);
});

test('a persisted override is the displayed effective endpoint', () => {
  assert.deepEqual(
    providerEndpointPresentation({
      providerType: 'alibaba',
      baseUrl: '  https://relay.example.com/alibaba/v1/  ',
    }),
    {
      value: 'https://relay.example.com/alibaba/v1/',
      editable: false,
      emptyState: 'missing',
    },
  );
});

test('displaying a custom endpoint masks URL credentials without hiding its route', () => {
  assert.deepEqual(
    providerEndpointPresentation({
      providerType: 'openai-compatible',
      baseUrl:
        'https://relay-user:relay-password@relay.example.com/v1?api-version=2026-08-01&api_key=secret-value',
    }),
    {
      value:
        'https://<redacted>@relay.example.com/v1?api-version=2026-08-01&api_key=<redacted>',
      editable: true,
      emptyState: 'missing',
    },
  );
});

test('custom relays and local runtimes retain endpoint editing', () => {
  assert.deepEqual(
    providerEndpointPresentation({
      providerType: 'openai-compatible',
      baseUrl: 'https://relay.example.com/v1',
    }),
    {
      value: 'https://relay.example.com/v1',
      editable: true,
      emptyState: 'missing',
    },
  );
  assert.deepEqual(
    providerEndpointPresentation({ providerType: 'ollama' }),
    {
      value: PROVIDER_DEFAULTS.ollama.baseUrl,
      editable: true,
      emptyState: 'missing',
    },
  );
});

test('derived and OAuth endpoints remain visible but read-only', () => {
  assert.deepEqual(
    providerEndpointPresentation({
      providerType: 'cloudflare-workers-ai',
      baseUrl: 'https://api.cloudflare.com/client/v4/accounts/example/ai/v1',
    }),
    {
      value: 'https://api.cloudflare.com/client/v4/accounts/example/ai/v1',
      editable: false,
      emptyState: 'missing',
    },
  );
  assert.deepEqual(
    providerEndpointPresentation({ providerType: 'openai-codex' }),
    {
      value: PROVIDER_DEFAULTS['openai-codex'].baseUrl,
      editable: false,
      emptyState: 'managed',
    },
  );
});

test('an absent custom endpoint remains visible as a missing editable value', () => {
  assert.deepEqual(
    providerEndpointPresentation({ providerType: 'openai-compatible' }),
    { value: null, editable: true, emptyState: 'missing' },
  );
});
