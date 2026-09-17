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

import { forwardRef, useImperativeHandle, useState } from 'react';
import { NewProjectDialog } from '@maka/ui';

export interface NewProjectDialogHandle {
  open(): void;
}

/**
 * The New project dialog, with its open state kept out of the shell.
 *
 * AppShellContent is the one component the shell's hook contract counts, and a
 * `useState` there is a hook scoped to everything below it — for a dialog that
 * opens at most once in a session and re-renders nothing else when it does. The
 * handle says the same thing without the reach: the rail calls `open()`, it does
 * not read a boolean.
 */
export const NewProjectDialogHost = forwardRef<
  NewProjectDialogHandle,
  { onSubmit(name: string): void }
>(function NewProjectDialogHost(props, ref) {
  const [open, setOpen] = useState(false);
  useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), []);
  if (!open) return null;
  return (
    <NewProjectDialog
      onOpenChange={(next) => {
        if (!next) setOpen(false);
      }}
      onSubmit={(name) => props.onSubmit(name)}
    />
  );
});
