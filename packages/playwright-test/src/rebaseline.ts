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

import fs from 'fs';
import { types, parse, traverse, NodePath } from './common/babelBundle';
import { TestInfoImpl } from './common/testInfo';
import { RebaselinePayload } from './common/ipc';

export function isSupportedMatcher(matcherName: string) {
  return matcherName === 'toBe' || matcherName === 'toEqual';
}

export function updateSnapshotsMode(testInfo: TestInfoImpl): 'all' | 'none' | 'missing' {
  let updateSnapshots = testInfo.config.updateSnapshots;
  return updateSnapshots === 'missing' && testInfo.retry < testInfo.project.retries ? 'none' : updateSnapshots;
}

export function updateMatchersMode(testInfo: TestInfoImpl): 'all' | 'none' | 'missing' {
  const rebaselineMatchers = testInfo.config.rebaselineMatchers;
  return rebaselineMatchers === 'missing' && testInfo.retry < testInfo.project.retries ? 'none' : rebaselineMatchers;
}

export class Rebaseline {
  // Store rebaseline requests per-file. If multiple requests
  // for the same matcher come in, the last one wins.
  _requests: Map<string, Map<string, RebaselinePayload>> = new Map();

  addRebaseline(request: RebaselinePayload) {
    let requestIdToRequests = this._requests.get(request.file);
    if (!requestIdToRequests) {
      requestIdToRequests = new Map<string, RebaselinePayload>();
      this._requests.set(request.file, requestIdToRequests);
    }

    const id = `${request.lineNumber}:${request.columnNumber}`;
    requestIdToRequests.set(id, request);
  }

  async performRebaselines() {
    if (!this._requests.size)
      return;
    const unsatisfiedRequests = [];
    const allSourceCodes: Set<SourceCode> = new Set();
    for (const [file, requestIdToRequests] of this._requests) {
      const sourceCode = await SourceCode.read(file);
      allSourceCodes.add(sourceCode);
      const allMatchers = extractSourceCodeMatchers(sourceCode.filepath, sourceCode.code);

      // Sort requests in reverse order to apply edits.
      const requests = [...requestIdToRequests.values()];
      requests.sort((r1, r2) => r1.lineNumber !== r2.lineNumber ? r2.lineNumber - r1.lineNumber : r2.columnNumber - r1.columnNumber);

      for (const request of requests) {
        const offset = sourceCode.positionToOffset(request.lineNumber - 1, request.columnNumber - 1);
        const index = binarySearch(allMatchers, matcher => matcher.range.from - offset);
        const matcher = index !== -1 ? allMatchers[index] : undefined;
        if (!matcher || matcher.name !== request.matcherName) {
          unsatisfiedRequests.push(request);
          continue;
        }

        const newExpected = JSON.stringify(request.newExpected);
        if (matcher.argRange)
          sourceCode.replace(matcher.argRange.from, matcher.argRange.to, newExpected);
        else
          sourceCode.replace(matcher.range.from, matcher.range.to, matcher.name + '(' + newExpected + ')');
      }
    }
    await Promise.all([...allSourceCodes].map((sc: SourceCode) => sc.save()));
    if (unsatisfiedRequests.length) {
      const message = [
        'Failed to perform the following rebaselines:',
        ...unsatisfiedRequests.map(request => `- ${request.file}:${request.lineNumber + 1}`),
      ].join('\n');
      throw new Error(message);
    }
  }
}

class SourceCode {
  filepath: string;
  code: string;
  private _lineEndings: number[];
  private _hadChanges: boolean = false;

  static async read(filepath: string) {
    const code = await fs.promises.readFile(filepath, 'utf8');
    return new SourceCode(filepath, code);
  }

  constructor(filepath: string, code: string) {
    this.filepath = filepath;
    this.code = code;
    this._lineEndings = [];
    for (let i = 0; i < code.length; ++i) {
      if (code[i] === '\n')
        this._lineEndings.push(i);
    }
  }

  positionToOffset(lineNumber: number, columnNumber: number): number {
    return lineNumber === 0 ? columnNumber : this._lineEndings[lineNumber - 1] + 1 + columnNumber;
  }

  replace(from: number, to: number, text: string) {
    this._hadChanges = true;
    const delta = - to + from + text.length;
    this.code = this.code.substring(0, from) + text + this.code.substring(to);
  }

  async save() {
    if (!this._hadChanges)
      return;
    await fs.promises.writeFile(this.filepath, this.code, 'utf8');
    this._hadChanges = false;
  }
}

function binarySearch<T>(haystack: T[], check: (t: T) => number): number {
  let l = 0, r = haystack.length;
  while (l < r) {
    const m = (l + r) >> 1;
    const val = haystack[m];
    const result = check(val);
    if (result < 0)
      l = m + 1;
    else if (result > 0)
      r = m;
    else
      return m;
  }
  return -1;
}

type SourceCodeMatcher = {
  name: string;
  range: { from: number, to: number };
  argRange?: { from: number, to: number };
};

function extractSourceCodeMatchers(file: string, code: string): SourceCodeMatcher[] {
  const matchers: SourceCodeMatcher[] = [];
  const ast = parse(code, {
    allowImportExportEverywhere: true,
    sourceFilename: file,
    plugins: [
      ['typescript', { dts: false }]
    ]
  });

  traverse(ast, {
    CallExpression: path => {
      const { node } = path;
      if (!types.isMemberExpression(node.callee) || !types.isIdentifier(node.callee.property) || !isSupportedMatcher(node.callee.property.name))
        return;
      const argument = node.arguments.length ? node.arguments[0] : undefined;
      let hasIdentifier = false;
      if (argument) {
        const argPath = path.get('arguments.0') as NodePath;
        if (types.isIdentifier(argument)) {
          hasIdentifier = true;
        } else {
          argPath.traverse({
            Identifier: (path: NodePath) => {
              // Object property keys identify as Identifier as well.
              // Ignore these unless they are "computed": { [foo]: 'bar' }
              if (path.parentPath && types.isObjectProperty(path.parentPath.node) && path.parentKey === 'key' ) {
                hasIdentifier = path.parentPath.node.computed;
              } else {
                hasIdentifier = true;
              }

              if (hasIdentifier)
                path.stop();
            },
          });
        }
      }
      if (!hasIdentifier) {
        matchers.push({
          name: node.callee.property.name,
          range: { from: node.callee.property.start!, to: node.end! },
          argRange: argument ? { from: argument.start!, to: argument.end! } : undefined,
        });
      }
    }
  });
  matchers.sort((m1, m2) => m1.range.from - m2.range.from);
  return matchers;
}

