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

import {
  effectiveBaseUrl,
  PROVIDER_DEFAULTS,
  type LlmConnection,
} from '@maka/core/llm-connections';
import { redactSecrets } from '@maka/core/display-redaction';

export interface ProviderEndpointPresentation {
  /** The effective base endpoint, with any display-facing credentials masked. */
  value: string | null;
  /** Whether the connection detail page should offer an endpoint editor. */
  editable: boolean;
  /** Explains an absent concrete value without making the row disappear. */
  emptyState: 'managed' | 'missing';
}

/**
 * Resolve the endpoint fact shown on a provider connection detail page.
 *
 * Visibility and editability are deliberately separate. Built-in providers
 * still own their fixed URL, but the user needs to see it to distinguish
 * similarly named access paths and regions. Custom relays and local runtimes
 * keep the existing editor because their address genuinely belongs to the
 * connection. Derived endpoints (for example Cloudflare account URLs) are
 * concrete once persisted, but are never hand-edited here.
 */
export function providerEndpointPresentation(
  connection: {
    providerType: LlmConnection['providerType'];
    baseUrl?: string;
  },
): ProviderEndpointPresentation {
  const defaults = PROVIDER_DEFAULTS[connection.providerType];
  const effective = effectiveBaseUrl(connection).trim();
  const value = endpointForDisplay(effective);
  const editable = defaults.authKind !== 'oauth_token'
    && !defaults.baseUrlTemplate
    && (!defaults.baseUrl || defaults.category === 'local');

  return {
    value: value || null,
    editable,
    emptyState: defaults.authKind === 'oauth_token' ? 'managed' : 'missing',
  };
}

function endpointForDisplay(value: string): string {
  if (!value) return value;
  // URL query secrets use the shared display redactor. URL userinfo needs one
  // extra boundary: `https://user:password@host` is valid baseUrl input but
  // neither part may become settings-page text. Keep one marker so the user
  // can still tell that the saved endpoint carries embedded credentials.
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      const withoutCredentials = parsed.toString();
      return redactSecrets(
        withoutCredentials.replace(`${parsed.protocol}//`, `${parsed.protocol}//<redacted>@`),
      );
    }
  } catch {
    // Persistence already validates provider base URLs. A legacy malformed
    // value still gets best-effort masking rather than disappearing.
  }
  return redactSecrets(value);
}
