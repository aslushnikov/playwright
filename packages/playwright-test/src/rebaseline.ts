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
import path from 'path';
import crypto from 'crypto';
import { types, parse, traverse, codeFrameColumns } from './common/babelBundle';
import type { TestStep } from '../types/testReporter';
import readline from 'readline';
import { FullConfigInternal } from './common/types';
import { TestInfoImpl } from './common/testInfo';

export function isSupportedMatcher(matcherName: string) {
  return matcherName === 'toBe' || matcherName === 'toEqual';
}

export function updateSnapshotsMode(testInfo: TestInfoImpl): 'all' | 'none' | 'missing' {
  let updateSnapshots = testInfo.config.updateSnapshots;
  return updateSnapshots === 'missing' && testInfo.retry < testInfo.project.retries ? 'none' : updateSnapshots;
}

type RebaselineRequest = {
  matcherName: string;
  lineNumber: number;
  columnNumber: number;
  file: string;
  value: any;
};

type SourceCodeMatcher = {
  name: string;
  range: { from: number, to: number },
  argRange?: { from: number, to: number },
};

export class Rebaseline {
  // Store rebaseline requests per-file. If multiple requests
  // for the same matcher come in, the last one wins.
  _requests: Map<string, Map<string, RebaselineRequest>> = new Map();

  onStepEnd(step: TestStep, rebaselineInfo: any) {
    if (!step.location || !rebaselineInfo)
      return;

    const request = {
      matcherName: rebaselineInfo.matcherName,
      file: step.location.file,
      lineNumber: step.location.line - 1,
      columnNumber: step.location.column - 1,
      value: rebaselineInfo.value,
    };

    let requestIdToRequests = this._requests.get(request.file);
    if (!requestIdToRequests) {
      requestIdToRequests = new Map<string, RebaselineRequest>();
      this._requests.set(request.file, requestIdToRequests);
    }

    const id = `${request.lineNumber}:${request.columnNumber}`;
    requestIdToRequests.set(id, request);
  }

  async save() {
    if (!this._requests.size)
      return;
    const allSourceCodes: Set<SourceCode> = new Set();
    for (const [file, requestIdToRequests] of this._requests) {
      const sourceCode = await SourceCode.read(file);
      allSourceCodes.add(sourceCode);
      const allMatchers = extractSourceCodeMatchers(sourceCode.filepath, sourceCode.code);

      // Sort requests in reverse order to apply edits.
      const requests = [...requestIdToRequests.values()];
      requests.sort((r1, r2) => r1.lineNumber !== r2.lineNumber ? r2.lineNumber - r1.lineNumber : r2.columnNumber - r1.columnNumber);
      for (const request of requests) {
        const offset = sourceCode.positionToOffset(request.lineNumber, request.columnNumber);
        const index = binarySearch(allMatchers, matcher => matcher.range.from - offset);
        const matcher = index !== -1 ? allMatchers[index] : undefined;
        if (!matcher || matcher.name !== request.matcherName)
          continue; // Failed to rebaseline.

        const newValue = JSON.stringify(request.value);
        if (matcher.argRange)
          sourceCode.replace(matcher.argRange.from, matcher.argRange.to, newValue);
        else
          sourceCode.replace(matcher.range.from, matcher.range.to, matcher.name + '(' + newValue + ')');
      }
    }
    await Promise.all([...allSourceCodes].map((sc: SourceCode) => sc.save()));
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
      if (node.arguments.length && !(types.isLiteral(node.arguments[0]) || types.isUnaryExpression(node.arguments[0])))
        return;
      const argument = node.arguments.length ? node.arguments[0] : undefined;
      matchers.push({
        name: node.callee.property.name,
        range: { from: node.callee.property.start!, to: node.end! },
        argRange: argument ? { from: argument.start!, to: argument.end! } : undefined,
      });
    }
  });
  matchers.sort((m1, m2) => m1.range.from - m2.range.from);
  return matchers;
}
