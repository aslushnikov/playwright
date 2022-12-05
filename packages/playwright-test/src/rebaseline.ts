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
import { types, parse, traverse, codeFrameColumns } from './babelBundle';
import type { TestStep } from '../types/testReporter';
import readline from 'readline';

function inlineReplace(matcher: SourceCodeMatcher, request: RebaselineRequest) {
  const newValue = JSON.stringify(request.value);
  if (!matcher.argStart || !matcher.argEnd)
    throw new Error('internal error: cannot replace value');
  request.sourceCode.replace(matcher.argStart.value, matcher.argEnd.value, newValue);
}

async function updateSnapshot(matcher: SourceCodeMatcher, request: RebaselineRequest) {
  if (!request.actualPath || !request.snapshotPath)
    throw new Error('internal error: cannot update matcher');
  await fs.promises.copyFile(request.actualPath, request.snapshotPath);
}

const supportedMatchers = {
  'toBe': inlineReplace,
  'toEqual': inlineReplace,
  'toMatchSnapshot': updateSnapshot,
  'toHaveScreenshot': updateSnapshot,
};

async function saveRequests(requests: RebaselineRequest[]) {
  await fs.promises.writeFile('./rebaseline.json', JSON.stringify(requests.map(request => request.serialize()), null, 2));
}

export class RebaselineLog {
  _failedSteps: TestStep[] = [];
  _rebaselineInfos: any[] = [];

  onStepEnd(step: TestStep, rebaselineInfo: any) {
    if (!step.error || !rebaselineInfo)
      return;
    this._failedSteps.push(step);
    this._rebaselineInfos.push(rebaselineInfo);
  }

  async save() {
    const requests = await RebaselineRequest.fromFailedSteps(this._failedSteps, this._rebaselineInfos);
    await saveRequests(requests);
  }
}

export async function rebaselineCommand() {
  const rawRequests: RawRebaselineRequest[] = JSON.parse(await fs.promises.readFile('./rebaseline.json', 'utf8'));
  const requests = new Set(await RebaselineRequest.fromJSON(rawRequests));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });  
  const question = (q: string): Promise<string> => new Promise(resolve => rl.question(q, resolve));

  for (const request of requests) {
    const matcher = request.sourceCode.findMatcher(request.matcherName, request.offset.value);
    if (!matcher)
      throw new Error('internal error: failed to process');

    const [line, column] = request.sourceCode.offsetToPosition(request.offset.value);
    const highlighted = codeFrameColumns(request.sourceCode.code, { start: { line: line + 1, column: column + 1 } }, { highlightCode: true, linesAbove: 5, linesBelow: 0 });
    console.log(`---------------------`);
    console.log(`file: ${path.relative(process.cwd(), request.sourceCode.filepath)}`)
    console.log(`---------------------`);
    console.log(highlighted);
    const answer = await question(`Update expectation to match? (y/N) `);
    if (answer.toLowerCase().includes('y')) {
      await (supportedMatchers as any)[request.matcherName](matcher, request);
      requests.delete(request);
      await saveRequests([...requests]);
      await request.sourceCode.save();
    }
  }
  rl.close();

  /*
  for (const code of await Promise.all([...sourceCodesCache.values()])) {
    // await code.save();
    console.log(`=====================`);
    console.log(code.filepath);
    console.log(`---------------------`);
    console.log(code.code);
    console.log(`=====================`);
  }
  */
}

type RawRebaselineRequest = {
  matcherName: string,
  offset: number,
  file: string,
  md5hash: string,
  // matcher-specific info
  value: any,
  actualPath?: string,
  snapshotPath?: string,
};

class RebaselineRequest {
  sourceCode: SourceCode;
  matcherName: string;
  offset: LiveOffset;
  value: any;

  actualPath?: string;
  snapshotPath?: string;

  static async fromJSON(rawRequests: RawRebaselineRequest[]): Promise<RebaselineRequest[]> {
    const sourceCodesCache: Map<string, Promise<SourceCode>> = new Map();
    const requests: (RebaselineRequest|undefined)[] = await Promise.all(rawRequests.map(async (rawRequest: RawRebaselineRequest) => {
      const sourceCode = await SourceCode.read(rawRequest.file, sourceCodesCache);
      // We cannot construct outdated rebaseline requests.
      if (sourceCode.md5hash() !== rawRequest.md5hash)
        return undefined;
      return new RebaselineRequest(sourceCode, rawRequest);
    }));
    return (requests.filter(r => !!r) as RebaselineRequest[]).sort((r1: RebaselineRequest, r2: RebaselineRequest) => {
      if (r1.sourceCode.filepath !== r2.sourceCode.filepath)
        return r1.sourceCode.filepath < r2.sourceCode.filepath ? -1 : 1;
      return r1.offset.value - r2.offset.value;    
    });
  }

  static async fromFailedSteps(failedSteps: TestStep[], rebaselineInfos: any[]): Promise<RebaselineRequest[]> {
    const result: RebaselineRequest[] = [];
    const sourceCodesCache: Map<string, Promise<SourceCode>> = new Map();
    for (let i = 0; i < failedSteps.length; ++i) {
      const step = failedSteps[i];
      const rebaselineInfo = rebaselineInfos[i];
      if (!step.location)
        continue;
      const sourceCode = await SourceCode.read(step.location.file, sourceCodesCache);
      result.push(new RebaselineRequest(sourceCode, {
        matcherName: rebaselineInfo.matcherName,
        file: sourceCode.filepath,
        offset: sourceCode.positionToOffset(step.location.line - 1, step.location.column - 1),
        md5hash: sourceCode.md5hash(),

        value: rebaselineInfo.value,
        actualPath: rebaselineInfo.actualPath,
        snapshotPath: rebaselineInfo.snapshotPath,
      }));
    }
    return result;
  }

  constructor(sourceCode: SourceCode, raw: RawRebaselineRequest) {
    this.sourceCode = sourceCode;
    this.matcherName = raw.matcherName;
    this.offset = sourceCode.liveOffset(raw.offset);
    this.value = raw.value;
    this.actualPath = raw.actualPath;
    this.snapshotPath = raw.snapshotPath; 
  }

  serialize(): RawRebaselineRequest {
    return {
      matcherName: this.matcherName,
      offset: this.offset.value,
      value: this.value,
      file: this.sourceCode.filepath,
      md5hash: this.sourceCode.md5hash(),
      actualPath: this.actualPath,
      snapshotPath: this.snapshotPath,
    };
  }
}

type SourceCodeMatcher = {
  name: string,
  offset: LiveOffset,
  argStart?: LiveOffset,
  argEnd?: LiveOffset,
};

class LiveOffset {
  value: number;

  constructor(offset: number) {
    this.value = offset;
  }
}

export class SourceCode {
  filepath: string;
  code: string;
  _lineEndings: number[];
  _liveOffsets: LiveOffset[] = [];
  _hadChanges: boolean = false;
  _md5: string = '';
  _matchers?: SourceCodeMatcher[];

  static async read(filepath: string, cache: Map<string, Promise<SourceCode>>|undefined = undefined) {
    let code = cache ? cache.get(filepath) : undefined;
    if (!code) {
      code = Promise.resolve().then(async () => {
        return new SourceCode(filepath, await fs.promises.readFile(filepath, 'utf8'));
      });
      if (cache)
        cache.set(filepath, code);
    }
    return code;
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

  findMatcher(name: string, offset: number): SourceCodeMatcher|undefined {
    const matchers = this._ensureMatchers();
    const index = binarySearch(matchers, matcher => matcher.offset.value - offset);
    const result = matchers[index];
    return result && result.name === name ? result : undefined;
  }

  _ensureMatchers() {
    if (this._matchers)
      return this._matchers;
    this._matchers = [];
    const ast = parse(this.code, {
      allowImportExportEverywhere: true,
      sourceFilename: this.filepath,
      plugins: [
        ['typescript', { dts: false }]
      ]
    });

    traverse(ast, {
      CallExpression: path => {
        const { node } = path;
        if (!types.isMemberExpression(node.callee) || !types.isIdentifier(node.callee.property) || !((supportedMatchers as any)[node.callee.property.name]))
          return;
        if (node.arguments.length && !types.isLiteral(node.arguments[0]))
          return;
        const argument = node.arguments.length ? node.arguments[0] : undefined;
        this._matchers!.push({
          name: node.callee.property.name,
          offset: this.liveOffset(node.callee.property.start!),
          argStart: argument && argument.start ? this.liveOffset(argument.start) : undefined,
          argEnd: argument && argument.end ? this.liveOffset(argument.end) : undefined,
        });
      }
    });
    this._matchers.sort((m1, m2) => m1.offset.value - m2.offset.value);
    return this._matchers;
  }

  positionToOffset(lineNumber: number, columnNumber: number): number {
    return lineNumber === 0 ? columnNumber : this._lineEndings[lineNumber - 1] + 1 + columnNumber;
  }

  offsetToPosition(offset: number): number[] {
    const lineNumber = binarySearch(this._lineEndings, le => le - offset);
    const columnNumber = lineNumber === 0 ? offset : offset - this._lineEndings[lineNumber - 1] - 1
    return [lineNumber, columnNumber];
  }

  md5hash() {
    if (!this._md5)
      this._md5 = crypto.createHash('md5').update(this.code).digest('hex');
    return this._md5;
  }

  liveOffset(offset: number) {
    const live = new LiveOffset(offset);
    this._liveOffsets.push(live);
    return live;
  }

  replace(from: number, to: number, text: string) {
    this._hadChanges = true;
    this._md5 = '';
    const delta = - to + from + text.length;
    this.code = this.code.substring(0, from) + text + this.code.substring(to);
    for (const liveOffset of this._liveOffsets) {
      if (liveOffset.value <= from)
        continue;
      if (liveOffset.value >= to)
        liveOffset.value += delta;
      else
        throw new Error('internal error: LiveOffset was removed due to edit operation');
    }
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
  return l;
}
