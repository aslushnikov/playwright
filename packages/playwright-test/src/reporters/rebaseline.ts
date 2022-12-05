/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Reporter } from '../../types/testReporter';
import type { FullConfig, TestCase, Suite, TestResult, FullResult, TestStep, TestError } from '../../types/testReporter';
import fs from 'fs';
import { SourceCode } from '../rebaseline';

class RebaselineReporter implements Reporter {
  _failedSteps: TestStep[] = [];

  onBegin(config: FullConfig, suite: Suite) {
  }

  onStepEnd(test: TestCase, result: TestResult, step: TestStep) {
    if (!step.error)
      return;
    this._failedSteps.push(step);
  }

  async onEnd() {
    const result = [];
    const sourceCodesCache: Map<string, SourceCode> = new Map();
    for (const step of this._failedSteps) {
      if (!step.location)
        continue;
      const sourceCode = await SourceCode.read(step.location.file, sourceCodesCache);
      result.push({
        ...(step as any)._rebaselineInfo,
        file: sourceCode.filepath,
        offset: sourceCode.positionToOffset(step.location.line - 1, step.location.column - 1),
      });
    }
    await fs.promises.writeFile('./rebaseline.json', JSON.stringify(result, null, 2));
  }
}

export default RebaselineReporter;
