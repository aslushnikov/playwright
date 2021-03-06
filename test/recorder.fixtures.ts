/**
 * Copyright Microsoft Corporation. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { folio as baseFolio } from './fixtures';
import { internalCallMetadata } from '../lib/server/instrumentation';

const fixtures = baseFolio.extend<{
  recorderFrame: () => Promise<any>,
  recorderClick: (selector: string) => Promise<void>
}>();

fixtures.recorderFrame.init(async ({context, toImpl}, runTest) => {
  await runTest(async () => {
    while (!toImpl(context).recorderAppForTest)
      await new Promise(f => setTimeout(f, 100));
    return toImpl(context).recorderAppForTest._page.mainFrame();
  });
});

fixtures.recorderClick.init(async ({ recorderFrame }, runTest) => {
  await runTest(async (selector: string) => {
    const frame = await recorderFrame();
    await frame.click(internalCallMetadata(), selector, {});
  });
});

export const folio = fixtures.build();
